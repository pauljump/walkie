import Foundation
import Combine

// The call. Turns the standup into a hands-free conversation with Mara: continuous
// ears (SpeechRecognizer) + a voice (Speaker) + the broker feed (Standup), driven by
// one small state machine.
//
//   listening ──(you pause)──▶ thinking ──(Mara replies)──▶ speaking ──(she finishes)──▶ listening
//
// Half-duplex by design: while Mara is speaking the mic is muted so she never hears
// herself. A tap interrupts her and reopens the mic (interrupt()). Operator-triggered:
// nothing listens or speaks until the Director taps Start.
@MainActor
final class VoiceSession: ObservableObject {
    enum State { case idle, listening, thinking, speaking }

    @Published private(set) var state: State = .idle
    @Published private(set) var partial = ""        // mirrors the live transcript for the UI
    var isActive: Bool { state != .idle }

    let ears = SpeechRecognizer()
    // The mouth is chosen from AppSettings.voiceMode and can be hot-swapped at runtime
    // (switchSpeaker). No longer a hardcoded SystemSpeaker.
    private var mouth: Speaker
    private weak var standup: Standup?
    private var cancellables = Set<AnyCancellable>()
    // A speaker switch requested while Mara is mid-turn is deferred until the call is idle,
    // so we never yank the voice out from under an in-flight utterance.
    private var pendingSwitch: SpeakerMode?

    init() {
        mouth = VoiceSession.makeSpeaker(AppSettings.shared.voiceMode)
    }

    // Instantiate the concrete speaker for a mode. Premium is locked in this build, so it
    // silently degrades to the robot voice (the UI shows the lock separately).
    private static func makeSpeaker(_ mode: SpeakerMode) -> Speaker {
        switch mode {
        case .robot:    return SystemSpeaker()
        case .byoVoice: return BYOVoiceSpeaker(brokerConfig: AppSettings.shared.brokerConfig,
                                               apiKey: AppSettings.shared.voiceApiKey)
        case .premium:  return SystemSpeaker()   // locked → robot until subscribed
        }
    }

    // Wire to the live feed. Mara's curated replies become spoken words.
    func attach(_ standup: Standup) {
        self.standup = standup
        standup.onEMReply = { [weak self] text in self?.maraSpoke(text) }
        ears.onUtterance = { [weak self] said in self?.heard(said) }
        mouth.onFinish = { [weak self] in self?.maraFinished() }
        ears.$partial
            .receive(on: RunLoop.main)
            .sink { [weak self] in self?.partial = $0 }
            .store(in: &cancellables)
        // Re-select the speaker if the user changes voice mode on the Settings tab.
        AppSettings.shared.$voiceMode
            .receive(on: RunLoop.main)
            .sink { [weak self] mode in self?.switchSpeaker(mode) }
            .store(in: &cancellables)
    }

    // Hot-swap the voice mid-session. If Mara is thinking/speaking, defer until idle so the
    // current turn finishes cleanly; otherwise swap now. Handlers are re-attached to the new
    // mouth so the call loop keeps driving it.
    func switchSpeaker(_ mode: SpeakerMode) {
        guard mode != mouth.voiceMode else { return }
        guard state == .idle || state == .listening else {
            pendingSwitch = mode          // queue it; applied in maraFinished()
            return
        }
        mouth.stop()
        mouth.onFinish = nil
        let next = VoiceSession.makeSpeaker(mode)
        next.onFinish = { [weak self] in self?.maraFinished() }
        mouth = next
    }

    // MARK: - Call control

    func start() {
        guard state == .idle else { return }
        ears.startListening()
        state = .listening
    }

    func end() {
        ears.stopListening()
        mouth.stop()
        partial = ""
        state = .idle
    }

    // Tap while Mara is speaking: cut her off, hand the floor back to the Director.
    func interrupt() {
        guard state == .speaking else { return }
        mouth.stop()
        ears.resume()
        state = .listening
    }

    // MARK: - Transitions

    // A complete utterance was heard — send it as the Director; await Mara.
    private func heard(_ said: String) {
        standup?.addDirectorReply(said)
        if state == .listening { state = .thinking }
    }

    // Mara answered — deafen the mic and speak her line.
    private func maraSpoke(_ text: String) {
        guard isActive else { return }   // only speak during a live call
        let line = Self.speakable(text)
        guard !line.isEmpty else { return }
        ears.pause()
        state = .speaking
        mouth.speak(line)
    }

    private func maraFinished() {
        guard isActive else { return }
        ears.resume()
        state = .listening
        // Apply a voice switch that arrived mid-turn, now that we're back to idle-ish.
        if let mode = pendingSwitch {
            pendingSwitch = nil
            switchSpeaker(mode)
        }
    }

    // Strip status emoji and light markdown so the voice reads naturally.
    private static func speakable(_ text: String) -> String {
        var s = text
        for junk in ["✅", "⚠️", "**", "`", "#"] { s = s.replacingOccurrences(of: junk, with: "") }
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
