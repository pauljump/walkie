import SwiftUI

// What the agent is waiting on, pinned above the composer until answered: a permission prompt
// (Allow / Always / Deny, or tell it what to do instead) or one or more multiple-choice questions.
struct AskCard: View {
    let ask: AgentEvent
    let agent: Agent
    let reply: (_ choice: String?, _ answers: [String: String]?, _ message: String?) -> Void

    @State private var instead = ""
    @State private var picks: [String: Set<String>] = [:]
    @State private var other: [String: String] = [:]
    @State private var showDiff = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: ask.type == "question" ? "questionmark.bubble.fill" : "hand.raised.fill").foregroundStyle(WK.waiting)
                Text(ask.type == "question" ? "\(agent.short) is asking" : "\(agent.short) wants to run").font(.caption.weight(.semibold)).foregroundStyle(WK.waiting)
            }
            if ask.type == "question" { questions } else { permission }
        }
        .padding(12)
        .background(WK.surface, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(WK.waiting.opacity(0.35)))
    }

    @ViewBuilder private var permission: some View {
        Text(ask.title ?? "").font(WK.mono).lineLimit(6).textSelection(.enabled)
        if let d = ask.detail, !d.isEmpty {
            ScrollView { Text(d).font(.caption).foregroundStyle(WK.textSecondary).frame(maxWidth: .infinity, alignment: .leading) }
                .frame(maxHeight: 140)
        }
        if let diff = ask.diff, !diff.isEmpty {
            DisclosureGroup("Changes", isExpanded: $showDiff) { ScrollView { DiffView(diff: diff) }.frame(maxHeight: 260) }
                .font(.caption)
        }
        HStack(spacing: 8) {
            ForEach(ask.options ?? [], id: \.id) { o in
                Button(o.label) { reply(o.id, nil, nil) }
                    .buttonStyle(.borderedProminent)
                    .tint(o.style == "destructive" ? WK.surfaceHi : (o.id == "allow" || o.id == "accept" ? WK.ok : WK.surfaceHi))
                    .foregroundStyle(o.style == "destructive" ? WK.error : (o.id == "allow" || o.id == "accept" ? WK.onAccent : WK.textPrimary))
                    .font(.subheadline.weight(.semibold))
            }
        }
        HStack {
            TextField("Or tell \(agent.short) what to do instead", text: $instead)
                .font(.footnote)
                .submitLabel(.send)
                .onSubmit(denyWithNote)
            if !instead.isEmpty { Button("Send", action: denyWithNote).font(.footnote.weight(.semibold)) }
        }
    }

    private func denyWithNote() {
        let t = instead.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        let deny = ask.options?.first { $0.style == "destructive" }?.id ?? "deny"
        reply(deny, nil, t)
    }

    @ViewBuilder private var questions: some View {
        ForEach(ask.questions ?? [], id: \.question) { q in
            VStack(alignment: .leading, spacing: 6) {
                if let h = q.header, !h.isEmpty { Text(h.uppercased()).font(.caption2.weight(.semibold)).foregroundStyle(WK.textTertiary) }
                Text(q.question).font(.subheadline.weight(.medium))
                ForEach(q.options ?? [], id: \.label) { o in
                    let on = picks[q.question, default: []].contains(o.label)
                    Button { toggle(q, o.label) } label: {
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: on ? (q.multiSelect == true ? "checkmark.square.fill" : "largecircle.fill.circle") : (q.multiSelect == true ? "square" : "circle"))
                                .foregroundStyle(on ? WK.accent : WK.textTertiary)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(o.label).font(.subheadline)
                                if let d = o.description, !d.isEmpty { Text(d).font(.caption).foregroundStyle(WK.textSecondary) }
                            }
                            Spacer(minLength: 0)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                TextField("Other…", text: Binding(get: { other[q.question, default: ""] }, set: { other[q.question] = $0 }))
                    .font(.footnote)
            }
        }
        HStack {
            Button("Submit") { reply(nil, answers, nil) }
                .buttonStyle(.borderedProminent).tint(WK.accent).foregroundStyle(WK.onAccent)
                .disabled(!complete)
            Button("Dismiss") { reply(nil, nil, "The user dismissed the question.") }
                .foregroundStyle(WK.textSecondary)
        }
    }

    private func toggle(_ q: AskQuestion, _ label: String) {
        var set = picks[q.question, default: []]
        if q.multiSelect == true { if set.contains(label) { set.remove(label) } else { set.insert(label) } }
        else { set = [label] }
        picks[q.question] = set
    }

    private var answers: [String: String] {
        var out: [String: String] = [:]
        for q in ask.questions ?? [] {
            let typed = other[q.question, default: ""].trimmingCharacters(in: .whitespacesAndNewlines)
            let chosen = (q.options ?? []).map(\.label).filter { picks[q.question, default: []].contains($0) }
            out[q.question] = (chosen + (typed.isEmpty ? [] : [typed])).joined(separator: ", ")
        }
        return out
    }

    private var complete: Bool { answers.values.allSatisfy { !$0.isEmpty } }
}
