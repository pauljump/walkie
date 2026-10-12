import SwiftUI

/// The plan a conversation's agent proposed: one line per project, tap to review and start.
struct PlanCard: View {
    let plan: ProjectPlan
    let review: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(plan.tasks.isEmpty ? "Nothing ready to hand off yet" : "Plan for \(plan.tasks.count) project\(plan.tasks.count == 1 ? "" : "s")",
                  systemImage: "square.split.2x2")
                .font(.subheadline.weight(.semibold))
            ForEach(plan.tasks, id: \.self) { t in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text((t.project as NSString).lastPathComponent).font(.footnote.weight(.semibold))
                    Text(t.title ?? t.brief).font(.footnote).foregroundStyle(WK.textSecondary).lineLimit(1)
                }
            }
            if !plan.tasks.isEmpty {
                Button("Review and start", action: review).font(.subheadline.weight(.semibold)).buttonStyle(.borderedProminent).controlSize(.small)
                    .padding(.top, 2)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(WK.surface, in: RoundedRectangle(cornerRadius: 14))
    }
}

/// Review a plan before anything runs: keep or drop each project, read or edit its brief, pick who does
/// it, then start them all. Each new session links back to this conversation.
struct DispatchSheet: View {
    let from: String
    let plan: ProjectPlan
    let open: (SessionRoute) -> Void
    @Environment(Bridge.self) private var bridge
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @AppStorage("wk.lastModel") private var lastModelJSON = ""
    @State private var paywallFor: Agent?

    struct Row: Identifiable {
        let id = UUID()
        var on = true
        var cwd: String
        var title: String
        var brief: String
        var model: ModelOption?
    }
    @State private var rows: [Row] = []
    @State private var mode: SessionMode = .ask
    @State private var picking: UUID?
    @State private var editing: UUID?
    @State private var starting = false
    @State private var result: DispatchResult?
    @State private var error: String?
    /// One id for this plan's start, so a retry after a timeout can't start the sessions twice.
    @State private var clientId = UUID().uuidString

    private var chosen: [Row] { rows.filter(\.on) }

    var body: some View {
        NavigationStack {
            List {
                if let result {
                    Section("Started") {
                        ForEach(result.sessions) { s in
                            Button { dismiss(); open(SessionRoute(key: s.key, agent: s.agent, cwd: s.cwd ?? "", title: s.title)) } label: {
                                HStack { AgentBadge(agent: s.agent); Text((s.cwd.map { ($0 as NSString).lastPathComponent }) ?? s.key); Spacer(); Image(systemName: "chevron.right").font(.caption).foregroundStyle(WK.textTertiary) }
                            }
                            .foregroundStyle(WK.textPrimary)
                        }
                    }
                    if !result.failed.isEmpty {
                        Section("Didn't start") {
                            ForEach(result.failed, id: \.self) { f in
                                VStack(alignment: .leading, spacing: 2) {
                                    Text((f.cwd.map { ($0 as NSString).lastPathComponent }) ?? "Task").font(.subheadline.weight(.semibold))
                                    Text(f.error).font(.caption).foregroundStyle(WK.error)
                                }
                            }
                        }
                    }
                } else {
                    Section {
                        Picker("Mode", selection: $mode) {
                            Text(SessionMode.ask.label).tag(SessionMode.ask)
                            Text(SessionMode.auto.label).tag(SessionMode.auto)
                        }
                    } footer: {
                        Text(mode == .ask ? "Each session asks you before risky steps; those show under Needs you." : "Each session edits files without asking. Antigravity always runs sandboxed.")
                    }
                    ForEach($rows) { $row in
                        Section {
                            Toggle(isOn: $row.on) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text((row.cwd as NSString).lastPathComponent).font(.body.weight(.semibold))
                                    Text(row.title).font(.subheadline).foregroundStyle(WK.textSecondary).lineLimit(2)
                                }
                            }
                            if row.on {
                                Button { picking = row.id } label: { ModelChip(model: row.model, fallback: .claude) }
                                    .buttonStyle(.plain)
                                if editing == row.id {
                                    TextEditor(text: $row.brief).frame(minHeight: 160).font(.footnote)
                                } else {
                                    Button { editing = row.id } label: {
                                        Text(row.brief).font(.footnote).foregroundStyle(WK.textSecondary).lineLimit(4)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityHint("Edit the brief")
                                }
                            }
                        }
                    }
                    if let error { Section { Text(error).font(.footnote).foregroundStyle(WK.error) } }
                }
            }
            .navigationTitle(result == nil ? "Send to projects" : "Started")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(result == nil ? "Cancel" : "Done") { dismiss() } }
                if result == nil {
                    ToolbarItem(placement: .confirmationAction) {
                        if starting { ProgressView() }
                        else { Button("Start \(chosen.count)") { start() }.disabled(chosen.isEmpty).fontWeight(.semibold) }
                    }
                }
            }
            .sheet(item: Binding(get: { picking.map { PickTarget(id: $0) } }, set: { picking = $0?.id })) { target in
                ModelPicker(selection: Binding(
                    get: { rows.first { $0.id == target.id }?.model },
                    set: { m in if let i = rows.firstIndex(where: { $0.id == target.id }) { rows[i].model = m } }))
            }
            .interactiveDismissDisabled(starting)
            .sheet(item: $paywallFor) { a in PaywallSheet(wanted: a) }
            .task {
                guard rows.isEmpty else { return }
                let last = lastModelJSON.data(using: .utf8).flatMap { try? JSONDecoder().decode(ModelOption.self, from: $0) }
                rows = plan.tasks.map { Row(cwd: $0.project, title: $0.title ?? String($0.brief.prefix(80)), brief: $0.brief, model: last) }
            }
        }
    }

    private struct PickTarget: Identifiable { let id: UUID }

    private func start() {
        // Free for one subscription: every chosen CLI must be allowed before anything starts.
        if let blocked = chosen.map({ $0.model?.harness ?? .claude }).first(where: { !store.allows($0) }) { paywallFor = blocked; return }
        for r in chosen { store.claim(r.model?.harness ?? .claude) }
        starting = true
        error = nil
        let tasks: [[String: Any]] = chosen.map { r in
            let agent = r.model?.harness ?? .claude
            var t: [String: Any] = ["cwd": r.cwd, "agent": agent.rawValue, "brief": r.brief]
            if let m = r.model?.id { t["model"] = m }
            // Antigravity can't ask from the phone, so it always runs sandboxed.
            if agent == .agy || mode == .auto { t["mode"] = "auto" }
            return t
        }
        Task {
            defer { starting = false }
            do { result = try await bridge.dispatch(from: from, tasks: tasks, clientId: clientId) }
            catch { self.error = error.localizedDescription }
        }
    }
}
