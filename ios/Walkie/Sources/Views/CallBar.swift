import SwiftUI

// The hands-free call control. No push-to-talk: tap once to start the call, then just
// talk and listen — Mara answers aloud in your ear. While she's speaking the bar reads
// "tap to interrupt" and a tap hands the floor back to you. Tap End to hang up.
struct CallBar: View {
    @EnvironmentObject var standup: Standup
    @StateObject private var voice = VoiceSession()

    var body: some View {
        VStack(spacing: 10) {
            if voice.isActive && !voice.partial.isEmpty {
                Text(voice.partial)
                    .font(.wkBody(15))
                    .foregroundStyle(WK.textPrimary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 22)
                    .transition(.opacity)
            }
            if voice.isActive { activeBar } else { startBar }
        }
        .padding(.bottom, 8)
        .animation(.easeInOut(duration: 0.2), value: voice.state)
        .onAppear { voice.attach(standup) }
    }

    // Idle: one tap to open the line.
    private var startBar: some View {
        Button { voice.start() } label: {
            HStack(spacing: 14) {
                Image(systemName: "waveform")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(WK.bgBottom)
                Text("Tap to start the call")
                    .font(.wkBody(15, .semibold))
                    .foregroundStyle(WK.bgBottom)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .background(RoundedRectangle(cornerRadius: 26).fill(WK.signal))
            .padding(.horizontal, 16)
        }
        .buttonStyle(.plain)
    }

    // Live: state on the left, hang-up on the right. The whole row is tappable so a tap
    // interrupts Mara mid-sentence (no-op in other states).
    private var activeBar: some View {
        HStack(spacing: 14) {
            stateDot
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.wkBody(15, .medium)).foregroundStyle(WK.textPrimary)
                Text(subtitle).font(.wkBody(12)).foregroundStyle(WK.textTertiary)
            }
            Spacer()
            Button { voice.end() } label: {
                Image(systemName: "phone.down.fill")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(WK.textPrimary)
                    .frame(width: 46, height: 46)
                    .background(Circle().fill(WK.alert.opacity(0.22)))
                    .overlay(Circle().stroke(WK.alert.opacity(0.5), lineWidth: 1))
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .background(RoundedRectangle(cornerRadius: 26).fill(WK.surface))
        .overlay(RoundedRectangle(cornerRadius: 26).stroke(WK.hairline, lineWidth: 1))
        .padding(.horizontal, 16)
        .contentShape(Rectangle())
        .onTapGesture { voice.interrupt() }
    }

    private var stateDot: some View {
        Circle()
            .fill(dotColor)
            .frame(width: 10, height: 10)
            .scaleEffect(voice.state == .listening ? 1.25 : 1.0)
            .animation(voice.state == .listening
                       ? .easeInOut(duration: 0.7).repeatForever(autoreverses: true)
                       : .default, value: voice.state)
    }

    private var dotColor: Color {
        switch voice.state {
        case .listening: return WK.signal
        case .thinking:  return WK.build
        case .speaking:  return WK.shipped
        case .idle:      return WK.textTertiary
        }
    }

    private var title: String {
        switch voice.state {
        case .listening: return "Listening"
        case .thinking:  return "Mara's on it…"
        case .speaking:  return "Mara speaking"
        case .idle:      return ""
        }
    }

    private var subtitle: String {
        switch voice.state {
        case .listening: return "just talk · pause to send"
        case .thinking:  return "working the room"
        case .speaking:  return "tap anywhere to interrupt"
        case .idle:      return ""
        }
    }
}
