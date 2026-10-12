import SwiftUI

/// Every model on every subscription in one list, grouped by what it is rather than which app runs
/// it. Each row shows the harness that would run it and how much of that plan is left.
struct ModelPicker: View {
    @Binding var selection: ModelOption?
    /// Set when switching inside an existing session: only this app's models can take the next turn.
    var harness: Agent? = nil
    var title = "Who does this?"
    /// Continuing elsewhere: this app's models are the ones you're leaving.
    var excluding: Agent? = nil
    @Environment(Bridge.self) private var bridge
    @Environment(\.dismiss) private var dismiss
    @State private var models: [ModelOption] = []
    @State private var usage: [String: UsageProvider] = [:]
    @State private var search = ""
    @State private var error: String?

    static let groups: [(String, [String])] = [
        ("Claude", ["Claude Fable", "Claude Opus", "Claude Sonnet", "Claude Haiku"]),
        ("GPT", ["GPT"]),
        ("Gemini", ["Gemini Pro", "Gemini Flash"]),
        ("Grok", ["Grok"]),
        ("Open-weight", ["GPT-OSS", "Other"]),
    ]

    private var filtered: [ModelOption] {
        let q = search.lowercased()
        let pool = (harness.map { h in models.filter { $0.harness == h } } ?? models).filter { $0.harness != excluding }
        return q.isEmpty ? pool : pool.filter { "\($0.name) \($0.id) \($0.harness.name)".lowercased().contains(q) }
    }

    var body: some View {
        NavigationStack {
            List {
                Section { UsageStrip() }
                if let harness { Section { Text("Switching models inside a conversation stays with \(harness.name). To move it to another subscription, use Continue in another subscription.").font(.footnote).foregroundStyle(WK.textSecondary) } }
                if excluding != nil { Section { Text("The new conversation starts with this one's transcript, in the same folder.").font(.footnote).foregroundStyle(WK.textSecondary) } }
                ForEach(Self.groups, id: \.0) { group, families in
                    let rows = filtered.filter { families.contains($0.family) }
                    let current = rows.filter { $0.older != true }
                    let older = rows.filter { $0.older == true }
                    if !rows.isEmpty {
                        Section(group) {
                            ForEach(current, id: \.key) { m in row(m) }
                            if !older.isEmpty {
                                DisclosureGroup("Older versions (\(older.count))") {
                                    ForEach(older, id: \.key) { m in row(m) }
                                }
                                .font(.subheadline)
                                .foregroundStyle(WK.textSecondary)
                            }
                        }
                    }
                }
                if models.isEmpty && error == nil { HStack { ProgressView(); Text("Asking your Mac…").foregroundStyle(WK.textSecondary) } }
                if let error { Text(error).foregroundStyle(WK.error).font(.footnote) }
            }
            .searchable(text: $search, prompt: "Search models")
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .task {
                do {
                    async let m = bridge.models()
                    async let u = bridge.usage()
                    let (mm, uu) = try await (m, u)
                    models = mm
                    usage = Dictionary(uniqueKeysWithValues: uu.map { ($0.id, $0) })
                } catch { self.error = error.localizedDescription }
            }
        }
    }

    private func row(_ m: ModelOption) -> some View {
        let plan = usage[m.harness.plan]
        return Button {
            selection = m
            dismiss()
        } label: {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(m.name).font(.body.weight(selection?.key == m.key ? .semibold : .regular))
                        if m.isDefault == true { Text("default").font(.caption2).foregroundStyle(WK.textTertiary) }
                    }
                    if let d = m.description, !d.isEmpty {
                        Text(d).font(.caption).foregroundStyle(WK.textSecondary).lineLimit(2)
                    }
                    HStack(spacing: 6) {
                        AgentBadge(agent: m.harness)
                        if let plan {
                            Circle().fill(plan.color).frame(width: 6, height: 6)
                            Text(plan.short).font(.caption2).foregroundStyle(plan.state == "full" ? WK.error : WK.textTertiary)
                        }
                        if !m.harness.asksPermission { Text("runs sandboxed").font(.caption2).foregroundStyle(WK.textTertiary) }
                        if let e = m.efforts, e.count > 1 { Text("effort \(Composer.effortLabel(e.first!).lowercased())–\(Composer.effortLabel(e.last!).lowercased())").font(.caption2).foregroundStyle(WK.textTertiary) }
                    }
                }
                Spacer(minLength: 0)
                if selection?.key == m.key { Image(systemName: "checkmark").foregroundStyle(WK.accent) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(plan?.state == "full" ? 0.55 : 1)
    }
}

/// The "who" chip on a new session: the picked model and the harness that will run it.
struct ModelChip: View {
    let model: ModelOption?
    let fallback: Agent
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "sparkles").font(.caption)
            Text(model?.name ?? "Default \(fallback.short) model").font(.subheadline.weight(.semibold))
            AgentBadge(agent: model?.harness ?? fallback)
            Image(systemName: "chevron.down").font(.caption2).foregroundStyle(WK.textTertiary)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(WK.surface, in: Capsule())
    }
}
