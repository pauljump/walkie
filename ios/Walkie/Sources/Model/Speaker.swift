import Foundation
import AVFoundation

// The voice that speaks Mara aloud. Kept behind a protocol on purpose: the whole
// "phone call with your EM" hinges on whether the voice feels human, and we can't
// know that until the Director walks with it. So the synthesis is isolated here — if Apple's
// on-device voice feels robotic, swap SystemSpeaker for a NeuralSpeaker (cloud TTS)
// without touching the call loop. Frontier technique: isolate the uncertain
// dependency behind a seam, decide after real signal.
// The three voice modes the user can pick on the Settings tab. Robot is the on-device
// AVSpeechSynthesizer (default, free, no keys). BYO calls the user's own conductor /tts
// proxy with their own ElevenLabs/Cartesia key. Premium is a Stripe-gated stub — locked
// until the user subscribes (payment is stubbed in this build).
enum SpeakerMode: String, CaseIterable, Identifiable {
    case robot
    case byoVoice
    case premium
    var id: String { rawValue }

    var title: String {
        switch self {
        case .robot:    return "Robot"
        case .byoVoice: return "BYO Voice"
        case .premium:  return "Premium"
        }
    }
    var blurb: String {
        switch self {
        case .robot:    return "On-device voice. Free, no keys, works offline."
        case .byoVoice: return "Your own ElevenLabs/Cartesia key via your Mac. Natural voice."
        case .premium:  return "Our hosted premium voices. Unlock with a subscription."
        }
    }
    var isLocked: Bool { self == .premium }
}

@MainActor
protocol Speaker: AnyObject {
    var isSpeaking: Bool { get }
    var onFinish: (() -> Void)? { get set }
    // Which mode this speaker implements — lets VoiceSession know what's currently mounted.
    var voiceMode: SpeakerMode { get }
    func speak(_ text: String)
    func stop()
}

// The modes the app ships support for. Premium is listed but locked (see SpeakerMode.isLocked).
extension Speaker {
    static var availableModes: [SpeakerMode] { SpeakerMode.allCases }
}

// On-device synthesis via AVSpeechSynthesizer. $0, no keys, no network latency,
// works in the user's ear over AirPods. Picks the best available en-US voice
// (premium/enhanced if the user has downloaded one in Settings → Accessibility).
@MainActor
final class SystemSpeaker: NSObject, Speaker, AVSpeechSynthesizerDelegate {
    @Published private(set) var isSpeaking = false
    var onFinish: (() -> Void)?
    let voiceMode: SpeakerMode = .robot

    private let synth = AVSpeechSynthesizer()
    private let voice = SystemSpeaker.bestVoice()

    override init() {
        super.init()
        synth.delegate = self
    }

    func speak(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { onFinish?(); return }
        let u = AVSpeechUtterance(string: t)
        u.voice = voice
        u.rate = AVSpeechUtteranceDefaultSpeechRate * 0.96  // a hair under default; calmer
        u.pitchMultiplier = 1.0
        u.postUtteranceDelay = 0.05
        isSpeaking = true
        synth.speak(u)
    }

    func stop() {
        guard synth.isSpeaking else { return }
        synth.stopSpeaking(at: .immediate)
        isSpeaking = false
    }

    // Prefer a downloaded premium/enhanced voice; fall back to the default en-US voice.
    private static func bestVoice() -> AVSpeechSynthesisVoice? {
        let enUS = AVSpeechSynthesisVoice.speechVoices().filter { $0.language == "en-US" }
        if let premium = enUS.first(where: { $0.quality == .premium }) { return premium }
        if let enhanced = enUS.first(where: { $0.quality == .enhanced }) { return enhanced }
        return AVSpeechSynthesisVoice(language: "en-US")
    }

    // MARK: AVSpeechSynthesizerDelegate
    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
        // Only hand the floor back when nothing else is queued — if Mara sent two lines
        // in a row, don't reopen the mic between them (she'd transcribe her own voice).
        Task { @MainActor in
            guard !self.synth.isSpeaking else { return }
            self.isSpeaking = false
            self.onFinish?()
        }
    }
    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) {
        Task { @MainActor in self.isSpeaking = false }
    }
}
