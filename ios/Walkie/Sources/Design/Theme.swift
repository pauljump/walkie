import SwiftUI
import UIKit

// Walkie design system — "city dusk": cool graphite-indigo night, warm bone text,
// one amber signal accent (the lit window at dusk). Calm, premium, not trying too
// hard. Status lives on the agent strip; the feed carries only real signal. The
// palette enforces product law #1 (no rambling) visually: ambient state vs. real
// interjection.

enum WK {
    static let bgTop     = Color(hex: 0x1B2233)
    static let bgBottom  = Color(hex: 0x0C0F18)
    static let surface   = Color(hex: 0x1E2536)
    static let surfaceHi = Color(hex: 0x283047)
    static let hairline  = Color(hex: 0x333C54)

    static let textPrimary   = Color(hex: 0xEDEBE3)
    static let textSecondary = Color(hex: 0x9AA1B6)
    static let textTertiary  = Color(hex: 0x646C84)

    static let signal  = Color(hex: 0xE7B15A) // amber accent — the EM, the lit window
    static let shipped = Color(hex: 0x6FE39B) // green — done / ready
    static let build   = Color(hex: 0x6AA6F0) // blue — building
    static let alert   = Color(hex: 0xF0A06A) // warm — decision / needs you

    // Settings / form palette (extends city dusk). Inputs sit a shade above the surface with
    // a hairline border; error text is a clear warm red; locked/premium wears a muted gold.
    static let error       = Color(hex: 0xE86A6A) // failed connection / bad key
    static let inputBg     = Color(hex: 0x232B40) // text-field fill, above surface
    static let inputBorder = Color(hex: 0x3A4560) // text-field hairline
    static let locked      = Color(hex: 0xB89A5E) // muted gold — premium locked badge

    static let rCard: CGFloat = 22
    static let rChip: CGFloat = 16
}

struct DuskBackground: View {
    var body: some View {
        LinearGradient(colors: [WK.bgTop, WK.bgBottom], startPoint: .top, endPoint: .bottom)
            .ignoresSafeArea()
    }
}

extension Font {
    // Rounded for a spoken, friendly feel on display text; system for body.
    static func wkDisplay(_ size: CGFloat, _ weight: Weight = .semibold) -> Font {
        .system(size: size, weight: weight, design: .rounded)
    }
    static func wkBody(_ size: CGFloat, _ weight: Weight = .regular) -> Font {
        .system(size: size, weight: weight)
    }
}

extension Color {
    init(hex: UInt) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xff) / 255,
                  green: Double((hex >> 8) & 0xff) / 255,
                  blue: Double(hex & 0xff) / 255,
                  opacity: 1)
    }
}
