import Foundation

// Where "Get a voice key" sends the user. BYO means the user pays their voice provider
// directly (the key rides to their own Mac's /tts proxy, never to us), so these are honest
// signup links, kept in ONE place so a URL change is a one-line edit and never scattered.
//
// Referral rule: a link may only carry a referral parameter for a program that actually
// exists, is enrolled, and is disclosed to the user right next to the link. Never invent
// a referral param, and never show a commission disclosure on a link that doesn't earn.
enum VoiceProvider: String, CaseIterable, Identifiable {
    case elevenLabs
    case cartesia
    case anthropic

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .elevenLabs: return "ElevenLabs"
        case .cartesia:   return "Cartesia"
        case .anthropic:  return "Anthropic"
        }
    }

    // The "Get a key" destination. Plain signup links today; an affiliate link may replace
    // one only under the referral rule above.
    var signupURL: URL {
        switch self {
        case .elevenLabs:
            return URL(string: "https://elevenlabs.io/sign-up")!
        case .cartesia:
            return URL(string: "https://play.cartesia.ai/sign-up")!
        case .anthropic:
            return URL(string: "https://console.anthropic.com/")!
        }
    }

    // No link currently carries a referral parameter, so nothing earns and nothing is
    // disclosed. Flip per-provider only when a real, enrolled program exists — the
    // disclosure below must always match reality.
    var earnsReferral: Bool { false }

    var disclosure: String? {
        earnsReferral ? "We may earn a referral commission if you subscribe via this link." : nil
    }

    // The provider the single "Get a voice key" link points at by default: the natural-voice
    // provider most BYO users reach for.
    static let primary: VoiceProvider = .elevenLabs
}
