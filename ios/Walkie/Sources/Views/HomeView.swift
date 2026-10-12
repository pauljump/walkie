import SwiftUI

enum Route: Hashable {
    case session(SessionRoute)
    case archived
    case search
}

// A session screen is either an existing session (key) or a new one not yet started
// (agent + cwd; the first send creates it).
struct SessionRoute: Hashable {
    var key: String?
    var agent: Agent
    var cwd: String
    var title: String?
    /// New conversation only: the model it starts on, and the conversation it continues (another session's key).
    var model: ModelOption? = nil
    var continueFrom: String? = nil
    var continueTitle: String? = nil
}

/// Home: what's left on each subscription, what needs you, and every conversation, newest first.
struct HomeView: View {
    @Environment(Bridge.self) private var bridge
    @Environment(Connection.self) private var connection
    @State private var path: [Route] = []
    @State private var sessions: [SessionSummary] = []
    @State private var loaded = false
    @State private var error: String?
    @State private var composing = false
    @State private var showSettings = false

    private var rows: [SessionSummary] { sessions.map(bridge.current) }
    private var needsYou: [SessionSummary] { rows.filter(\.isWaiting) }
    private var recent: [SessionSummary] { rows.filter { !$0.isWaiting } }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section { UsageStrip() }
                if connection.isDemo {
                    Section { DemoCard { showSettings = true } }
                }
                if bridge.state == .offline, loaded || error != nil {
                    Section { OfflineCard(error: bridge.lastError ?? error) { bridge.connect(); Task { await load() } } }
                }
                if let incompatible = bridge.incompatible {
                    Section { Label(incompatible, systemImage: "arrow.triangle.2.circlepath").foregroundStyle(WK.waiting) }
                }
                if !needsYou.isEmpty {
                    Section("Needs you") { ForEach(needsYou) { row($0) } }
                }
                Section {
                    ForEach(recent.prefix(60)) { row($0) }
                    if loaded && rows.isEmpty && error == nil {
                        ContentUnavailableView("No conversations yet", systemImage: "bubble.left.and.text.bubble.right",
                                               description: Text("Start one with the compose button."))
                    }
                    if !loaded && error == nil { HStack(spacing: 8) { ProgressView(); Text("Asking your Mac…").foregroundStyle(WK.textSecondary) } }
                } header: {
                    if !needsYou.isEmpty { Text("Recent") }
                }
                Section {
                    NavigationLink(value: Route.archived) { Label("Archived", systemImage: "archivebox").foregroundStyle(WK.textSecondary) }
                }
            }
            .listStyle(.insetGrouped)
            .listSectionSpacing(.compact)
            .navigationTitle("Walkie")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showSettings = true } label: { ConnectionPill() }.accessibilityLabel("Settings")
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    NavigationLink(value: Route.search) { Image(systemName: "magnifyingglass") }.accessibilityLabel("Search")
                    Button { composing = true } label: { Image(systemName: "square.and.pencil") }.accessibilityLabel("New conversation")
                }
            }
            .refreshable { await load() }
            .task { await load() }
            #if DEBUG
            // Screenshots: `-walkieOpen <key> -walkieOpenCwd <path>` opens a conversation; add
            // `-walkieContinue YES` to open "continue it elsewhere" for it instead.
            .task {
                let d = UserDefaults.standard
                guard path.isEmpty, let key = d.string(forKey: "walkieOpen"), let agent = Agent(rawValue: String(key.prefix { $0 != ":" })) else { return }
                let cwd = d.string(forKey: "walkieOpenCwd") ?? ""
                if d.bool(forKey: "walkiePlan") {
                    path = [.session(SessionRoute(key: key, agent: agent, cwd: cwd))]
                    return
                }
                path = d.bool(forKey: "walkieContinue")
                    ? [.session(SessionRoute(agent: .codex, cwd: cwd, continueFrom: key, continueTitle: "Fix the login bug"))]
                    : [.session(SessionRoute(key: key, agent: agent, cwd: cwd))]
            }
            #endif
            .onChange(of: bridge.listVersion) { Task { await load() } }
            .onChange(of: bridge.pendingOpen) { _, r in
                guard let r else { return }
                path = [.session(r)]
                bridge.pendingOpen = nil
            }
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .session(let r): SessionView(route: r)
                case .archived: ArchivedView()
                case .search: SearchView()
                }
            }
            .sheet(isPresented: $composing) {
                NewConversationSheet { r in path.append(.session(r)) }
            }
            .sheet(isPresented: $showSettings) { SettingsView() }
        }
    }

    private func row(_ s: SessionSummary) -> some View {
        NavigationLink(value: Route.session(SessionRoute(key: s.key, agent: s.agent, cwd: s.cwd ?? "", title: s.title))) {
            SessionRow(session: s, showProject: true)
        }
        .sessionActions(s)
    }

    private func load() async {
        do {
            sessions = try await bridge.sessions()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
    }
}

/// You're in the demo: say so, and point at the way out.
struct DemoCard: View {
    let settings: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("This is the demo", systemImage: "play.circle").font(.subheadline.weight(.semibold))
            Text("Sample conversations, no Mac. When you've installed the bridge on your Mac, pair from Settings.")
                .font(.caption).foregroundStyle(WK.textSecondary)
            Button("Pair with my Mac", action: settings).font(.caption.weight(.semibold)).padding(.top, 2)
        }
        .padding(.vertical, 4)
    }
}

/// The Mac can't be reached: say so plainly, with the one thing to try.
struct OfflineCard: View {
    let error: String?
    let retry: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Can't reach your Mac", systemImage: "wifi.slash").font(.subheadline.weight(.semibold))
            Text("Check that the Mac is awake and on Tailscale. Messages you write now send when it's back.")
                .font(.caption).foregroundStyle(WK.textSecondary)
            if let error { Text(error).font(.caption2).foregroundStyle(WK.textTertiary).lineLimit(2) }
            Button("Try again", action: retry).font(.caption.weight(.semibold)).padding(.top, 2)
        }
        .padding(.vertical, 4)
    }
}

/// New conversation: pick where, then who. The model list shows what's left on each subscription.
struct NewConversationSheet: View {
    let open: (SessionRoute) -> Void
    @Environment(Bridge.self) private var bridge
    @Environment(\.dismiss) private var dismiss
    @AppStorage("wk.lastModel") private var lastModelJSON = ""
    @AppStorage("wk.lastProject") private var lastProject = ""
    @State private var projects: [Project] = []
    @State private var search = ""
    @State private var error: String?
    @State private var model: ModelOption?
    @State private var picking = false

    private var shown: [Project] {
        search.isEmpty ? projects : projects.filter { $0.name.localizedCaseInsensitiveContains(search) || $0.path.localizedCaseInsensitiveContains(search) }
    }
    private var agent: Agent { model?.harness ?? .claude }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button { picking = true } label: { ModelChip(model: model, fallback: agent) }
                        .buttonStyle(.plain)
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
                Section("Where") {
                    ForEach(shown) { p in
                        Button {
                            lastProject = p.path
                            dismiss()
                            open(SessionRoute(agent: agent, cwd: p.path, model: model))
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(p.name).foregroundStyle(WK.textPrimary)
                                    Text(p.path.abbreviatedPath).font(.caption).foregroundStyle(WK.textTertiary).lineLimit(1).truncationMode(.head)
                                }
                                Spacer()
                                if p.path == lastProject { Image(systemName: "clock.arrow.circlepath").font(.caption).foregroundStyle(WK.textTertiary) }
                            }
                        }
                    }
                    if projects.isEmpty && error == nil { HStack(spacing: 8) { ProgressView(); Text("Asking your Mac…").foregroundStyle(WK.textSecondary) } }
                    if let error { Text(error).font(.footnote).foregroundStyle(WK.error) }
                }
            }
            .searchable(text: $search, prompt: "Find a project")
            .navigationTitle("New conversation")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .sheet(isPresented: $picking) { ModelPicker(selection: $model) }
            .task {
                if model == nil, let data = lastModelJSON.data(using: .utf8) { model = try? JSONDecoder().decode(ModelOption.self, from: data) }
                do {
                    let list = try await bridge.projects()
                    // The last place you started something comes first.
                    projects = list.sorted { a, b in a.path == lastProject ? true : b.path == lastProject ? false : (a.updatedAt ?? 0) > (b.updatedAt ?? 0) }
                } catch { self.error = error.localizedDescription }
            }
            .onChange(of: model) { _, m in
                if let m, let data = try? JSONEncoder().encode(m) { lastModelJSON = String(decoding: data, as: UTF8.self) }
            }
        }
    }
}

/// Swipe to archive or rename. Both go to the agent's own record when it keeps one (Claude, Codex),
/// so the change shows in the terminal and desktop too; otherwise Walkie keeps it (docs/SYNC.md).
struct SessionActions: ViewModifier {
    let session: SessionSummary
    @Environment(Bridge.self) private var bridge
    @State private var renaming = false
    @State private var newTitle = ""
    @State private var tapped = 0
    @State private var failure: String?

    func body(content: Content) -> some View {
        content
            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                Button { act { try await bridge.archive(session.key, cwd: session.cwd) } } label: { Label("Archive", systemImage: "archivebox") }
                    .tint(WK.textSecondary)
                Button { newTitle = session.displayTitle; renaming = true } label: { Label("Rename", systemImage: "pencil") }
                    .tint(WK.codex)
            }
            .sensoryFeedback(.selection, trigger: tapped)
            .alert("Rename", isPresented: $renaming) {
                TextField("Name", text: $newTitle)
                Button("Save") {
                    let t = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !t.isEmpty { act { try await bridge.rename(session.key, to: t, cwd: session.cwd) } }
                }
                Button("Cancel", role: .cancel) {}
            }
            .alert("Couldn't do that", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
                Button("OK", role: .cancel) {}
            } message: { Text(failure ?? "") }
    }

    private func act(_ op: @escaping () async throws -> Void) {
        tapped += 1
        Task { do { try await op() } catch { failure = error.localizedDescription } }
    }
}

extension View {
    func sessionActions(_ s: SessionSummary) -> some View { modifier(SessionActions(session: s)) }
}

struct SessionRow: View {
    let session: SessionSummary
    var showProject = false

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                Text(session.displayTitle).lineLimit(2)
                HStack(spacing: 6) {
                    AgentBadge(agent: session.agent)
                    if showProject, let cwd = session.cwd {
                        Text((cwd as NSString).lastPathComponent).font(.caption).foregroundStyle(WK.textSecondary).lineLimit(1)
                    }
                    if session.voice == true { Image(systemName: "waveform").font(.caption2).foregroundStyle(WK.textTertiary) }
                }
            }
            Spacer(minLength: 0)
            VStack(alignment: .trailing, spacing: 6) {
                TimelineView(.everyMinute) { _ in
                    Text(session.updated.short).font(.caption).foregroundStyle(WK.textTertiary).monospacedDigit()
                }
                StatusDot(session: session)
            }
        }
        .padding(.vertical, 2)
    }
}

struct ConnectionPill: View {
    @Environment(Bridge.self) private var bridge
    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(label).font(.caption).foregroundStyle(WK.textSecondary)
        }
        .animation(.snappy, value: bridge.state)
    }
    private var color: Color {
        switch bridge.state { case .online: WK.ok; case .connecting: WK.waiting; case .offline: WK.error }
    }
    private var label: String {
        switch bridge.state { case .online: "Mac"; case .connecting: "Connecting"; case .offline: "Offline" }
    }
}

struct SettingsView: View {
    @Environment(Connection.self) private var connection
    @Environment(Bridge.self) private var bridge
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var paywall = false

    var body: some View {
        @Bindable var store = store
        NavigationStack {
            Form {
                Section {
                    if store.purchased {
                        LabeledContent("Walkie for all subscriptions", value: "Yours")
                    } else if store.unlocked {
                        LabeledContent("Walkie for all subscriptions", value: "Open")
                    } else {
                        Picker("Free subscription", selection: Binding(get: { store.freeHarness ?? .claude }, set: { store.freeHarness = $0 })) {
                            ForEach(Agent.allCases) { a in Text(a.name).tag(a) }
                        }
                        Button("Use all subscriptions · \(store.priceLabel), once") { paywall = true }
                        Button("Restore purchase") { Task { await store.restore() } }
                    }
                    if let e = store.lastError, !store.purchased { Text(e).font(.footnote).foregroundStyle(WK.error) }
                } header: { Text("Subscriptions") } footer: {
                    Text(store.purchased ? "Every CLI, continue elsewhere, send to projects." : store.unlocked ? "Everything is open on this device." : "Walkie is free for one subscription. Buying once opens every CLI you pay for, on every device with your Apple Account.")
                }
                Section(connection.isDemo ? "Demo" : "Mac") {
                    if connection.isDemo {
                        Text("You're looking at sample conversations. Install the bridge on your Mac, then pair.").font(.footnote).foregroundStyle(WK.textSecondary)
                        Button("Pair with my Mac") { bridge.disconnect(); connection.forget(); dismiss() }
                    } else {
                        LabeledContent("Address", value: connection.host)
                        LabeledContent("Port", value: String(connection.port))
                        LabeledContent("Status", value: bridge.state == .online ? "Connected" : (bridge.lastError ?? "Offline"))
                        Button("Reconnect") { bridge.connect() }
                    }
                }
                Section {
                    Link("walkie.cc", destination: URL(string: "https://walkie.cc")!)
                    Link("Support", destination: URL(string: "https://walkie.cc/support")!)
                    Link("Privacy", destination: URL(string: "https://walkie.cc/privacy")!)
                }
                if !connection.isDemo {
                    Section {
                        Button("Unpair this phone", role: .destructive) {
                            bridge.disconnect()
                            connection.forget()
                            dismiss()
                        }
                    }
                }
            }
            .sheet(isPresented: $paywall) { PaywallSheet() }
            .navigationTitle("Settings")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

/// Everything you archived, wherever you archived it. Open one to read it; swipe to bring it back.
struct ArchivedView: View {
    @Environment(Bridge.self) private var bridge
    @State private var sessions: [SessionSummary] = []
    @State private var error: String?
    @State private var loaded = false
    @State private var search = ""

    private var shown: [SessionSummary] {
        search.isEmpty ? sessions : sessions.filter { $0.displayTitle.localizedCaseInsensitiveContains(search) }
    }

    var body: some View {
        List {
            ForEach(shown) { s in
                NavigationLink(value: Route.session(SessionRoute(key: s.key, agent: s.agent, cwd: s.cwd ?? "", title: s.title))) {
                    SessionRow(session: s, showProject: true)
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                    Button { unarchive(s) } label: { Label("Unarchive", systemImage: "tray.and.arrow.up") }.tint(WK.codex)
                }
            }
            if loaded && sessions.isEmpty && error == nil { Text("Nothing archived.").foregroundStyle(WK.textTertiary) }
            if !loaded { ProgressView() }
            if let error { Text(error).font(.footnote).foregroundStyle(WK.error) }
        }
        .searchable(text: $search, prompt: "Search archived")
        .navigationTitle("Archived")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .onChange(of: bridge.listVersion) { Task { await load() } }
    }

    private func load() async {
        do { sessions = try await bridge.archivedSessions(); error = nil } catch { self.error = error.localizedDescription }
        loaded = true
    }

    private func unarchive(_ s: SessionSummary) {
        sessions.removeAll { $0.key == s.key }
        Task { do { try await bridge.archive(s.key, false, cwd: s.cwd) } catch { self.error = error.localizedDescription; await load() } }
    }
}

/// Search every conversation, open or archived, by title or by what was said.
struct SearchView: View {
    @Environment(Bridge.self) private var bridge
    @State private var query = ""
    @State private var results: [SessionSummary] = []
    @State private var searching = false
    @State private var searched = ""
    @State private var error: String?

    var body: some View {
        List {
            if searching {
                HStack(spacing: 8) { ProgressView(); Text("Searching every conversation…").foregroundStyle(WK.textTertiary) }
            }
            ForEach(results) { s in
                NavigationLink(value: Route.session(SessionRoute(key: s.key, agent: s.agent, cwd: s.cwd ?? "", title: s.title))) {
                    VStack(alignment: .leading, spacing: 4) {
                        SessionRow(session: bridge.current(s), showProject: true)
                        Text(s.match == "text" ? "Found in the conversation" : "Found in the title").font(.caption2).foregroundStyle(WK.textTertiary)
                    }
                }
            }
            if !searching && !searched.isEmpty && results.isEmpty && error == nil {
                Text("Nothing matches “\(searched)”.").foregroundStyle(WK.textTertiary)
            }
            if let error { Text(error).font(.footnote).foregroundStyle(WK.error) }
        }
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search conversations")
        .onSubmit(of: .search) { Task { await run() } }
        .navigationTitle("Search")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func run() async {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard q.count >= 2 else { return }
        searching = true; error = nil
        defer { searching = false; searched = q }
        do { results = try await bridge.search(q) } catch { self.error = error.localizedDescription }
    }
}
