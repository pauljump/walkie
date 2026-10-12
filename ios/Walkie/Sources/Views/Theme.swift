import SwiftUI

// Native coding-client look: true black, quiet grays, white type; color only for agent identity
// and execution state.
enum WK {
    // Each color has a dark value (the original look) and a light one; the phone's setting picks.
    static let bg        = Color(light: 0xFFFFFF, dark: 0x000000)
    static let surface   = Color(light: 0xF2F2F7, dark: 0x161616)
    static let surfaceHi = Color(light: 0xE8E8ED, dark: 0x222222)
    static let hairline  = Color(light: 0xD1D1D6, dark: 0x303030)

    static let textPrimary   = Color(light: 0x111111, dark: 0xF5F5F5)
    static let textSecondary = Color(light: 0x5C5C63, dark: 0xA6A6A6)
    static let textTertiary  = Color(light: 0x8E8E93, dark: 0x6E6E6E)

    static let accent   = Color(light: 0x111111, dark: 0xF5F5F5)
    /// Text drawn on top of `accent`.
    static let onAccent = Color(light: 0xFFFFFF, dark: 0x000000)
    static let ok      = Color(light: 0x1F9D55, dark: 0x34C759)
    static let waiting = Color(light: 0xD97706, dark: 0xFF9F0A)
    static let error   = Color(light: 0xD93025, dark: 0xFF6961)

    static let claude = Color(light: 0xC4623F, dark: 0xD97757)
    static let codex  = Color(light: 0x2F6FDB, dark: 0x8AB4F8)
    static let agy    = Color(light: 0x2E9E4F, dark: 0x7BD88F)
    static let grok   = Color(light: 0x6B6B6B, dark: 0xC9C9C9)

    static func color(_ agent: Agent) -> Color {
        switch agent {
        case .claude: claude
        case .codex: codex
        case .agy: agy
        case .grok: grok
        }
    }

    static let mono = Font.system(.footnote, design: .monospaced)
}

extension Color {
    /// A color that follows light/dark mode.
    init(light: UInt, dark: UInt) {
        self.init(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(Color(hex: dark)) : UIColor(Color(hex: light)) })
    }

    init(hex: UInt) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xff) / 255,
                  green: Double((hex >> 8) & 0xff) / 255,
                  blue: Double(hex & 0xff) / 255,
                  opacity: 1)
    }
}

struct AgentBadge: View {
    let agent: Agent
    var body: some View {
        Text(agent.short)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6).padding(.vertical, 2)
            .foregroundStyle(WK.color(agent))
            .background(WK.color(agent).opacity(0.15), in: Capsule())
            .fixedSize()
    }
}

struct StatusDot: View {
    let session: SessionSummary
    var body: some View {
        Group {
            if session.isWaiting {
                Image(systemName: "hand.raised.fill").font(.caption).foregroundStyle(WK.waiting)
                    .transition(.scale.combined(with: .opacity))
            } else if session.isRunning {
                ProgressView().controlSize(.mini).transition(.opacity)
            }
        }
        .animation(.snappy, value: session.status)
    }
}
