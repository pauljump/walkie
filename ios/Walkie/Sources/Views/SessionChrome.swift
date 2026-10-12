import SwiftUI
import UIKit

// Around the conversation: the new-session header, messages on their way, offline and "New" lines, jump to latest.

struct NewSessionHeader: View {
    let agent: Agent
    let cwd: String
    @Binding var mode: SessionMode
    /// Set when this conversation continues another one: its title.
    var continueTitle: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(cwd.abbreviatedPath, systemImage: "folder").font(WK.mono).foregroundStyle(WK.textSecondary)
            if let continueTitle {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "arrow.triangle.branch").foregroundStyle(WK.color(agent))
                    VStack(alignment: .leading, spacing: 3) {
                        Text(continueTitle.isEmpty ? "Continues your conversation" : "Continues \u{201C}\(continueTitle)\u{201D}").font(.subheadline.weight(.semibold))
                        Text("\(agent.short) gets that conversation with your first message, so it picks up where you left off.")
                            .font(.caption).foregroundStyle(WK.textSecondary)
                    }
                }
                .padding(12).background(WK.surface, in: RoundedRectangle(cornerRadius: 12))
            }
            Picker("Mode", selection: $mode) {
                ForEach(SessionMode.allCases.filter { $0.available(for: agent) }) { m in
                    Text(agent == .agy && m == .auto ? "Auto (sandboxed)" : m.label).tag(m)
                }
            }
            .pickerStyle(.menu)
            if !agent.asksPermission {
                Text("Antigravity can't ask permission from your phone, so it runs in a sandbox without prompts.")
                    .font(.caption).foregroundStyle(WK.textTertiary)
            }
        }
        .padding(.vertical, 8)
    }
}

// MARK: Event rows

/// A message on its way: dimmed until the Mac has it, with a quiet line saying where it is.
struct PendingBubble: View {
    let item: Outgoing
    let retry: () -> Void
    let discard: () -> Void

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            HStack {
                Spacer(minLength: 40)
                Text(item.text)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(WK.surfaceHi, in: RoundedRectangle(cornerRadius: 16))
                    .opacity(item.state == .sent ? 1 : 0.55)
            }
            switch item.state {
            case .waiting:
                Label("Waiting for your Mac", systemImage: "clock").font(.caption2).foregroundStyle(WK.textTertiary)
            case .sending:
                Label("Sending…", systemImage: "arrow.up.circle").font(.caption2).foregroundStyle(WK.textTertiary)
            case .sent:
                EmptyView()
            case .failed:
                HStack(spacing: 10) {
                    Text(item.error.map { "Didn't send: \($0)" } ?? "Didn't send").font(.caption2).foregroundStyle(WK.error).lineLimit(2)
                    Button("Retry", action: retry).font(.caption2.weight(.semibold))
                    Button("Remove", role: .destructive, action: discard).font(.caption2)
                }
            }
        }
        .animation(.easeOut(duration: 0.2), value: item.state)
    }
}

/// Where the transcript picks up after you were offline.
struct AwayDivider: View {
    var body: some View {
        HStack(spacing: 8) {
            Rectangle().fill(WK.textTertiary.opacity(0.3)).frame(height: 0.5)
            Text("New").font(.caption2.weight(.semibold)).foregroundStyle(WK.textTertiary).fixedSize()
            Rectangle().fill(WK.textTertiary.opacity(0.3)).frame(height: 0.5)
        }
        .padding(.vertical, 4)
    }
}

/// Above the composer when the Mac can't be reached: you can keep typing into an existing session.
struct OfflineLine: View {
    let waiting: Int
    let newSession: Bool

    var body: some View {
        Label(text, systemImage: "wifi.slash")
            .font(.caption)
            .foregroundStyle(WK.textSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14).padding(.vertical, 4)
    }

    private var text: String {
        if newSession { return "Offline. New conversations start once your Mac is reachable." }
        if waiting > 0 { return "Offline · \(waiting) waiting to send" }
        return "Offline · messages send when you're back"
    }
}

/// Appears when you've scrolled up from the end of a conversation; takes you back to the latest.
struct JumpToLatest: View {
    let visible: Bool
    let action: () -> Void
    var body: some View {
        Group {
            if visible {
                Button(action: action) {
                    Image(systemName: "arrow.down").font(.subheadline.weight(.semibold))
                        .frame(width: 38, height: 38)
                        .background(.ultraThinMaterial, in: Circle())
                }
                .foregroundStyle(WK.textPrimary)
                .padding(14)
                .transition(.scale.combined(with: .opacity))
                .accessibilityLabel("Jump to latest")
            }
        }
        .animation(.snappy, value: visible)
    }
}
