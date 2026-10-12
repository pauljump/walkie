import SwiftUI

// The input bar. Typing "/" (or "$" for Codex skills) opens a filtered command list; while the
// agent works, Send becomes Stop unless you've typed something (which steers the running turn).
struct Composer: View {
    @Binding var input: String
    var focused: FocusState<Bool>.Binding
    let commands: [SlashCommand]
    let agent: Agent
    let running: Bool
    let sending: Bool
    let send: () -> Void
    let stop: () -> Void
    var modelName: String? = nil
    var chooseModel: (() -> Void)? = nil
    var efforts: [String] = []
    var effort: String? = nil
    var setEffort: ((String) -> Void)? = nil
    var placeholder: String? = nil
    /// Photos and files attached to the message being written (nil: this composer can't attach).
    var attachments: Binding<[Attachment]>? = nil
    var conversation: String? = nil

    static func effortLabel(_ e: String) -> String {
        switch e {
        case "xhigh": "Extra high"
        case "": "Default"
        default: e.prefix(1).uppercased() + e.dropFirst()
        }
    }

    private var query: String? {
        guard let first = input.first, first == "/" || first == "$", !input.contains(" ") else { return nil }
        return String(input.dropFirst()).lowercased()
    }
    private var matches: [SlashCommand] {
        guard let q = query else { return [] }
        return commands.filter { q.isEmpty || $0.name.lowercased().contains(q) }.prefix(8).map { $0 }
    }
    private var empty: Bool { input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (attachments?.wrappedValue.isEmpty ?? true) }

    var body: some View {
        VStack(spacing: 0) {
            if !matches.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(matches) { c in
                            Button { input = c.insertion } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("\(c.prefix ?? "/")\(c.name)").font(WK.mono)
                                    if let d = c.description, !d.isEmpty { Text(d).font(.caption).foregroundStyle(WK.textSecondary).lineLimit(1) }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 14).padding(.vertical, 8)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .frame(maxHeight: 240)
                .background(WK.surface)
            }
            Divider().overlay(WK.hairline)
            if let chooseModel {
                HStack {
                    Button(action: chooseModel) {
                        HStack(spacing: 4) {
                            Image(systemName: "sparkles").font(.caption2)
                            Text(modelName ?? "Model").font(.caption.weight(.semibold))
                            Image(systemName: "chevron.up.chevron.down").font(.caption2).foregroundStyle(WK.textTertiary)
                        }
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(WK.surface, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    if let setEffort, !efforts.isEmpty {
                        Menu {
                            Picker("Effort", selection: Binding(get: { effort ?? "" }, set: { setEffort($0) })) {
                                ForEach(efforts, id: \.self) { e in Text(Composer.effortLabel(e)).tag(e) }
                            }
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: "gauge.with.dots.needle.50percent").font(.caption2)
                                Text("Effort: \(Composer.effortLabel(effort ?? ""))").font(.caption.weight(.semibold))
                                Image(systemName: "chevron.up.chevron.down").font(.caption2).foregroundStyle(WK.textTertiary)
                            }
                            .padding(.horizontal, 10).padding(.vertical, 5)
                            .background(WK.surface, in: Capsule())
                        }
                        .foregroundStyle(WK.textPrimary)
                    }
                    Spacer()
                }
                .padding(.horizontal, 10).padding(.top, 8)
            }
            if let attachments, !attachments.wrappedValue.isEmpty { AttachmentTray(items: attachments) }
            HStack(alignment: .bottom, spacing: 8) {
                if let attachments { AttachButton(items: attachments, conversation: conversation).padding(.bottom, 6) }
                if !commands.isEmpty {
                Menu {
                    ForEach(commands.prefix(30)) { c in Button("\(c.prefix ?? "/")\(c.name)") { input = c.insertion } }
                } label: {
                    Image(systemName: "slash.circle").font(.title3).foregroundStyle(WK.textSecondary)
                }
                .padding(.bottom, 6)
                }
                TextField(placeholder ?? "Message \(agent.short)…", text: $input, axis: .vertical)
                    .lineLimit(1...8)
                    .focused(focused)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(WK.surface, in: RoundedRectangle(cornerRadius: 18))
                if running && empty {
                    Button(action: stop) {
                        Image(systemName: "stop.circle.fill").font(.system(size: 30)).foregroundStyle(WK.textPrimary)
                    }
                    .accessibilityLabel("Stop")
                } else {
                    Button(action: send) {
                        if sending { ProgressView().frame(width: 30, height: 30) }
                        else { Image(systemName: "arrow.up.circle.fill").font(.system(size: 30)).foregroundStyle(empty ? WK.textTertiary : WK.textPrimary) }
                    }
                    .disabled(empty || sending)
                    .accessibilityLabel("Send")
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
        }
        .background(WK.bg)
    }
}
