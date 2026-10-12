import SwiftUI

// One conversation with any of your agents. Reads like a chat and keeps the CLI's power inline: tool
// calls and diffs as expandable rows, permission prompts and questions as cards you answer in place,
// slash commands in the composer, Stop while it runs. When a subscription runs out, the conversation
// continues on another one.
struct SessionView: View {
    let route: SessionRoute
    @Environment(Bridge.self) private var bridge
    @Environment(Store.self) private var store
    @State private var key: String?
    @State private var paywallFor: Agent?
    @State private var asks: [QuickAsk] = []
    @State private var input = ""
    @State private var mode: SessionMode = .ask
    @State private var pick: ModelOption?
    @State private var picking = false
    @State private var continuing = false
    @State private var continueWith: ModelOption?
    @State private var startedAgent: Agent?
    @State private var effort: String?
    @State private var catalog: [ModelOption] = []
    @State private var plan: UsageProvider?
    @State private var sending = false
    @State private var error: String?
    @State private var commands: [SlashCommand] = []
    /// Whether the end of the conversation is on screen; new output only scrolls you down if it is.
    @State private var atBottom = true
    @State private var sentCount = 0
    @State private var attachments: [Attachment] = []
    /// The message whose time is showing (tap a message to see when it was sent).
    @State private var shownTime: String?
    @State private var openRoute: SessionRoute?
    /// The first message's id, kept across retries so a start that timed out can't start twice.
    @State private var startId = UUID().uuidString
    /// Send to projects: the plan being reviewed, and whether we're waiting for the agent to write one.
    @State private var reviewing: PlanReview?
    @State private var awaitingPlan = false
    @FocusState private var focused: Bool

    private var draftKey: String { key ?? "new:\(route.continueFrom ?? route.agent.rawValue):\(route.cwd)" }
    private var lastResultID: String? { events.last(where: { $0.kind == "result" })?.id }
    private var openAskCount: Int { openAsks.count }
    /// A result arriving now, not one loaded with the history.
    private var isVisibleResult: Bool { isRunning == false && sentCount > 0 }

    /// The CLI running this conversation: the picked model's for a new one, the route's otherwise.
    private var agent: Agent { key == nil ? (pick?.harness ?? route.agent) : (startedAgent ?? route.agent) }
    /// The model the next turn will use, as a catalog entry (for its effort levels).
    private var currentModel: ModelOption? {
        if let pick { return pick }
        guard let m = live?.model else { return nil }
        return catalog.first { $0.harness == agent && ($0.id == m || m.hasPrefix($0.id)) }
    }
    private var effortOptions: [String] {
        currentModel?.efforts ?? (agent == .claude ? ["low", "medium", "high", "xhigh", "max"] : [])
    }
    private var shownEffort: String? { effort ?? live?.effort ?? currentModel?.defaultEffort }
    /// What the chip shows: the pick for a new session, else the pending switch, else the live model.
    private var modelLabel: String {
        if let pick { return pick.name }
        if let m = live?.model, m != "default" { return ModelOption.displayName(m, harness: agent, in: catalog) }
        return "\(agent.short) default"
    }
    private var events: [AgentEvent] { key.flatMap { bridge.events[$0] } ?? [] }
    private var draft: String? { key.flatMap { bridge.drafts[$0] } }
    private var live: SessionSummary? { key.flatMap { bridge.liveSessions[$0] } }
    private var isRunning: Bool { live?.isRunning == true || live?.isWaiting == true }
    private var resolvedAsks: Set<String> { Set(events.compactMap { $0.kind == "resolved" ? $0.ask : nil }) }
    private var openAsks: [AgentEvent] { events.filter { $0.kind == "ask" && !resolvedAsks.contains($0.id) } }
    private var headerTitle: String {
        if let t = live?.title ?? route.title, !t.isEmpty { return WalkiePrompt.split(t).yours ?? t }
        if key == nil { return route.continueFrom == nil ? "New conversation" : "Continue" }
        return events.first { $0.kind == "user" }.flatMap { WalkiePrompt.split($0.text ?? "").yours }?.prefix(60).description ?? agent.name
    }
    private var visible: [AgentEvent] { events.filter { $0.kind != "resolved" && !($0.kind == "ask" && !resolvedAsks.contains($0.id)) } }
    /// This subscription is spent: its meter says full, or the last turn ended on a usage limit.
    private var outOfQuota: Bool {
        if plan?.state == "full" { return true }
        guard let last = events.last(where: { $0.kind == "result" || $0.kind == "error" }), last.ok != true else { return false }
        return (last.text ?? "").range(of: #"usage limit|rate limit|out of (usage|credits|quota)|quota"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        if key == nil { NewSessionHeader(agent: agent, cwd: route.cwd, mode: $mode, continueTitle: route.continueFrom == nil ? nil : (route.continueTitle ?? "")) }
                        ForEach(TimelineItem.group(visible)) { item in
                            timelineRow(item)
                                .contentShape(Rectangle())
                                .simultaneousGesture(TapGesture().onEnded { toggleTime(item) })
                        }
                        if let key {
                            ForEach(bridge.pending(for: key)) { item in
                                PendingBubble(item: item, retry: { bridge.retry(item.id) }, discard: { bridge.discard(item.id) })
                            }
                        }
                        if let draft, !draft.isEmpty {
                            MarkdownText(text: draft, color: WK.textPrimary.opacity(0.85))
                        } else if isRunning && openAsks.isEmpty {
                            WorkingLine()
                        }
                        Color.clear.frame(height: 1).id("bottom")
                            .onAppear { atBottom = true }
                            .onDisappear { atBottom = false }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                }
                .scrollDismissesKeyboard(.interactively)
                .defaultScrollAnchor(.bottom)
                // Follow new output only while you're at the end; reading back isn't interrupted.
                .onChange(of: events.count) { _, _ in if atBottom { withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } } }
                .onChange(of: key.map { bridge.pending(for: $0).count } ?? 0) { _, _ in withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
                .onChange(of: draft) { _, _ in if atBottom { proxy.scrollTo("bottom", anchor: .bottom) } }
                .overlay(alignment: .bottomTrailing) {
                    JumpToLatest(visible: !atBottom && !events.isEmpty) { withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
                }
                .animation(.snappy, value: atBottom)
            }

            if let key {
                ForEach(openAsks) { ask in
                    AskCard(ask: ask, agent: agent) { choice, answers, message in
                        Task { await answer(key, ask, choice: choice, answers: answers, message: message) }
                    }
                    .padding(.horizontal, 10).padding(.bottom, 6)
                }
            }
            if key != nil && outOfQuota && !isRunning {
                OutOfQuotaBar(agent: agent, plan: plan) { continuing = true }
            }
            if let error {
                Text(error).font(.footnote).foregroundStyle(WK.error).padding(.horizontal).padding(.bottom, 4)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if bridge.state != .online {
                OfflineLine(waiting: key.map { bridge.pending(for: $0).filter { $0.state != .sent }.count } ?? 0, newSession: key == nil)
            }
            if key == nil, !asks.isEmpty, input.isEmpty { QuickAsks(asks: asks) { input = $0.text; focused = true } }
            Composer(input: $input, focused: $focused, commands: commands, agent: agent,
                     running: isRunning, sending: sending, send: send, stop: stop,
                     modelName: modelLabel, chooseModel: { picking = true },
                     efforts: effortOptions, effort: shownEffort, setEffort: { e in changeEffort(e) },
                     placeholder: key == nil && route.continueFrom != nil ? "Continue with \(agent.short)…" : nil,
                     attachments: $attachments, conversation: key)
        }
        .background(WK.bg)
        .navigationTitle(headerTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text(headerTitle).font(.subheadline.weight(.semibold)).lineLimit(1)
                    HStack(spacing: 4) {
                        AgentBadge(agent: agent)
                        Text((route.cwd as NSString).lastPathComponent).font(.caption2).foregroundStyle(WK.textTertiary)
                    }
                }
            }
            if let key {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button { sendToProjects(key) } label: { Label("Send to projects…", systemImage: "square.split.2x2") }
                            .disabled(isRunning)
                        Button { continuing = true } label: { Label("Continue in another subscription", systemImage: "arrow.triangle.branch") }
                        Button { openRoute = SessionRoute(agent: agent, cwd: route.cwd, model: pick) } label: { Label("New conversation here", systemImage: "square.and.pencil") }
                        Divider()
                        Button { UIPasteboard.general.string = transcript() } label: { Label("Copy conversation", systemImage: "doc.on.doc") }
                        if let last = events.last(where: { $0.kind == "text" })?.text {
                            Button { UIPasteboard.general.string = last } label: { Label("Copy last reply", systemImage: "text.quote") }
                        }
                        Divider()
                        Button { Task { do { try await bridge.archive(key, cwd: route.cwd) } catch { self.error = error.localizedDescription } } } label: { Label("Archive", systemImage: "archivebox") }
                    } label: { Image(systemName: "ellipsis.circle") }
                    .accessibilityLabel("More")
                }
            }
        }
        .task {
            if key == nil, let k = route.key { key = k }
            if key == nil, pick == nil { pick = route.model }
            if let m = pick, !mode.available(for: m.harness) || m.harness == .agy { mode = m.harness == .agy ? .auto : .ask }
            if let key {
                bridge.watch(key)
                do { try await bridge.loadSession(key, cwd: route.cwd); bridge.markUnseen(key) } catch { self.error = error.localizedDescription }
            }
            commands = await bridge.commands(key: key, agent: agent)
            catalog = (try? await bridge.models()) ?? []
            if key == nil { asks = await bridge.asks(cwd: route.cwd) }
            #if DEBUG
            if UserDefaults.standard.bool(forKey: "walkiePaywall") { paywallFor = .codex }
            // Screenshots: `-walkiePlan YES` opens a sample plan's review sheet without asking the agent.
            if let key, UserDefaults.standard.bool(forKey: "walkiePlan") {
                let root = (route.cwd as NSString)
                reviewing = PlanReview(from: key, plan: ProjectPlan(tasks: [
                    .init(project: root.appendingPathComponent("walkie"), title: "Show a meter for Grok", brief: "Grok's allowance is only in its TUI. Find a read-only way to get it and add it to the usage strip. Done when the strip shows Grok with a reset time."),
                    .init(project: root.appendingPathComponent("openappco"), title: "List Open Flashcards on the site", brief: "Add Open Flashcards to apps.config.json with its icon and shot. Done when openappco.com shows it as In review."),
                    .init(project: root.appendingPathComponent("kit"), title: "Draft the doctor brief", brief: "Build the one-button root-cause brief from the cited record (specs/draft). Done when it renders for Rex's record."),
                ]))
            }
            #endif
        }
        .task(id: agent) {
            // This subscription's meter, so a spent one offers to continue elsewhere.
            plan = (try? await bridge.usage())?.first { $0.id == agent.plan }
        }
        .sheet(isPresented: $picking) { ModelPicker(selection: $pick, harness: key == nil ? nil : agent) }
        .sheet(isPresented: $continuing) { ModelPicker(selection: $continueWith, title: "Continue with", excluding: agent) }
        .sheet(item: $paywallFor) { a in PaywallSheet(wanted: a) }
        .onChange(of: continueWith) { _, m in
            guard let m, let key else { return }
            continueWith = nil
            guard store.allows(m.harness) else { paywallFor = m.harness; return }
            openRoute = SessionRoute(agent: m.harness, cwd: route.cwd, model: m, continueFrom: key, continueTitle: headerTitle)
        }
        .navigationDestination(item: $openRoute) { r in SessionView(route: r) }
        .sheet(item: $reviewing) { r in DispatchSheet(from: r.from, plan: r.plan) { route in openRoute = route } }
        .onChange(of: lastResultID) { _, _ in
            // The plan you asked for just arrived: open it for review.
            guard awaitingPlan, let key, let text = events.last(where: { $0.kind == "text" })?.text else { return }
            awaitingPlan = false
            if let plan = ProjectPlan.from(text), !plan.tasks.isEmpty { reviewing = PlanReview(from: key, plan: plan) }
        }
        .sensoryFeedback(.success, trigger: lastResultID) { _, new in new != nil && isVisibleResult }
        .sensoryFeedback(.warning, trigger: openAskCount) { old, new in new > old }
        .onChange(of: pick) { _, m in
            guard let m else { return }
            if !mode.available(for: m.harness) || (m.harness == .agy && mode == .ask) { mode = m.harness == .agy ? .auto : .ask }
            if let e = effort, !(m.efforts ?? []).contains(e) { effort = nil }
            if key == nil { Task { commands = await bridge.commands(key: nil, agent: m.harness) } }
        }
        .onDisappear { if let key { bridge.markSeen(key); bridge.unwatch(key); bridge.awayMarker[key] = nil } }
        // Unsent text stays with the conversation, like Messages.
        .onAppear { if input.isEmpty { input = bridge.composeDraft(for: draftKey) } }
        .onChange(of: input) { _, t in bridge.setComposeDraft(t, for: draftKey) }
    }

    /// The whole conversation as plain markdown: who said what, in order (tool steps left out).
    private func transcript() -> String {
        events.compactMap { e -> String? in
            guard let t = e.text?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
            switch e.kind {
            case "user": return "**You:** \(WalkiePrompt.split(t).yours ?? t)"
            case "text": return "**\(agent.name):** \(t)"
            default: return nil
            }
        }
        .joined(separator: "\n\n")
    }

    /// One row of the conversation: your message, a reply, another event, or a run of tool steps.
    @ViewBuilder private func timelineRow(_ item: TimelineItem) -> some View {
        if let key, let marker = bridge.awayMarker[key], item.events.contains(where: { $0.id == marker }) { AwayDivider() }
        if item.events.count == 1, let ev = item.events.first {
            if shownTime == ev.id, let ts = ev.ts { MessageTime(ms: ts, trailing: ev.kind == "user") }
            if ev.kind == "text", let key, let plan = ProjectPlan.from(ev.text ?? "") {
                PlanCard(plan: plan) { reviewing = PlanReview(from: key, plan: plan) }
            } else if ev.kind == "info", let link = ev.link {
                LinkRow(text: ev.text ?? "Continued", link: link) { openRoute = SessionRoute(key: link, agent: Agent(rawValue: String(link.prefix { $0 != ":" })) ?? agent, cwd: route.cwd) }
            } else {
                EventRow(event: ev, agent: agent, resolved: resolvedAsks.contains(ev.id))
            }
        } else {
            ToolGroup(steps: item.events)
        }
    }

    /// Tap a message to see when it was sent; tap again to hide it.
    private func toggleTime(_ item: TimelineItem) {
        guard item.events.count == 1, let e = item.events.first, ["user", "text"].contains(e.kind) else { return }
        withAnimation(.snappy) { shownTime = shownTime == e.id ? nil : e.id }
    }

    private func send() {
        let text = AttachmentText.join(input.trimmingCharacters(in: .whitespacesAndNewlines), attachments)
        guard !text.isEmpty, !sending else { return }
        // Free for one subscription: the first CLI you send on is it; a second one asks you to buy.
        guard store.allows(agent) else { paywallFor = agent; return }
        store.claim(agent)
        sending = true
        error = nil
        Task {
            defer { sending = false }
            do {
                if let key {
                    // Into the outbox: shows at once, goes when the Mac is reachable, runs exactly once.
                    bridge.enqueue(key, cwd: route.cwd, text: text, model: pick?.id)
                    sentCount += 1
                } else {
                    let s = try await bridge.start(agent: agent, cwd: route.cwd, text: text, mode: mode, model: pick?.id, effort: effort, continueFrom: route.continueFrom, clientId: startId)
                    key = s.key
                    startedAgent = s.agent
                    bridge.watch(s.key)
                    _ = try? await bridge.loadSession(s.key)
                    commands = await bridge.commands(key: s.key, agent: agent)
                }
                input = ""
                attachments = []
            } catch {
                // What you wrote stays in the box, so trying again is one tap.
                self.error = error.localizedDescription
            }
        }
    }

    private func sendToProjects(_ key: String) {
        error = nil
        Task {
            do { try await bridge.plan(key, cwd: route.cwd); awaitingPlan = true }
            catch { self.error = error.localizedDescription }
        }
    }

    private func changeEffort(_ e: String) {
        effort = e
        guard let key else { return }            // new session: sent with the first message
        Task {
            do { try await bridge.setEffort(key, cwd: route.cwd, effort: e) }
            catch { self.error = error.localizedDescription }
        }
    }

    private func stop() {
        guard let key else { return }
        Task { try? await bridge.interrupt(key) }
    }

    private func answer(_ key: String, _ ask: AgentEvent, choice: String?, answers: [String: String]?, message: String?) async {
        do { try await bridge.answer(key, askId: ask.id, choice: choice, answers: answers, message: message) }
        catch { self.error = error.localizedDescription }
    }
}

/// Above the composer when this subscription is spent: when it's back, and one tap to keep going elsewhere.
struct OutOfQuotaBar: View {
    let agent: Agent
    let plan: UsageProvider?
    let action: () -> Void
    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "gauge.with.dots.needle.100percent").foregroundStyle(WK.waiting)
            VStack(alignment: .leading, spacing: 1) {
                Text("\(agent.short) is out of usage").font(.subheadline.weight(.semibold))
                if let r = plan?.tightest?.resets { Text("Back \(UsageProvider.when(r))").font(.caption).foregroundStyle(WK.textSecondary) }
            }
            Spacer()
            Button("Continue elsewhere", action: action).font(.subheadline.weight(.semibold)).buttonStyle(.borderedProminent).controlSize(.small)
        }
        .padding(10)
        .background(WK.surface, in: RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal, 10).padding(.bottom, 6)
    }
}

/// "Continued in Codex →": a quiet line that opens the conversation it points to.
struct LinkRow: View {
    let text: String
    let link: String
    let open: () -> Void
    var body: some View {
        Button(action: open) {
            HStack(spacing: 6) {
                Image(systemName: "arrow.triangle.branch").font(.caption2)
                Text(text).font(.caption.weight(.medium))
                Image(systemName: "chevron.right").font(.caption2)
            }
            .foregroundStyle(WK.textSecondary)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(WK.surface, in: Capsule())
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity, alignment: .center)
    }
}

/// While an agent works and hasn't said anything yet.
struct WorkingLine: View {
    var body: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text("Working…").font(.footnote).foregroundStyle(WK.textTertiary)
        }
        .padding(.vertical, 4)
        .accessibilityLabel("Working")
    }
}

struct PlanReview: Identifiable {
    let id = UUID()
    let from: String
    let plan: ProjectPlan
}

/// Quick asks from ~/.walkie/walkie.json: one tap fills the composer.
struct QuickAsks: View {
    let asks: [QuickAsk]
    let pick: (QuickAsk) -> Void
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(asks) { a in
                    Button { pick(a) } label: {
                        Text(a.title).font(.footnote.weight(.medium))
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .background(WK.surface, in: Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 6)
        }
    }
}
