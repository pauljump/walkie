import SwiftUI

// Optional text input for the Director — type to Mara when voice won't do: URLs, PR numbers,
// exact prompts, anything speech mangles. It sends down the SAME path as a spoken line
// (Standup.addDirectorReply → broker.send), so Mara can't tell typed from spoken. Voice stays
// primary; this is the "if you want" lane for precision. Multi-line so a long prompt or a
// pasted link fits.
struct TypeBar: View {
    @EnvironmentObject var standup: Standup
    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField("Type to Mara…", text: $draft, axis: .vertical)
                .font(.wkBody(15))
                .foregroundStyle(WK.textPrimary)
                .tint(WK.signal)
                .lineLimit(1...5)
                .focused($focused)
                .submitLabel(.send)
                .onSubmit(send)

            Button(action: send) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(canSend ? WK.bgBottom : WK.textTertiary)
                    .frame(width: 34, height: 34)
                    .background(Circle().fill(canSend ? WK.signal : WK.surface))
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
            .animation(.easeInOut(duration: 0.15), value: canSend)
        }
        .padding(.leading, 18)
        .padding(.trailing, 8)
        .padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: 24).fill(WK.surface))
        .overlay(RoundedRectangle(cornerRadius: 24).stroke(WK.hairline, lineWidth: 1))
        .padding(.horizontal, 16)
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        standup.addDirectorReply(text)   // same path voice uses: shows in the feed + sends to Mara
        draft = ""
        focused = false
    }
}
