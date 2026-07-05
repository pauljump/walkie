import Foundation
import AVFoundation

// Why this exists: the Settings "Play sample" button sounded thin and robotic, and that was
// a bug, not the voice. AVSpeechSynthesizer only sounds full when an audio session category
// is active. During a live call the SpeechRecognizer sets .playAndRecord/.voiceChat, so the
// sample there is fine. But "Play sample" runs with NO live call, so the process default
// (.soloAmbient) routed the voice thin through the receiver AND honored the ring/silent
// switch. This helper activates a real playback session just for the sample, then hands it
// back so the next real call starts from a clean category.
enum SampleAudio {
    // Activate a playback session for a one-off sample. .spokenAudio is tuned for speech;
    // .duckOthers lowers other audio instead of stopping it.
    static func begin() {
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try? s.setActive(true)
    }

    // Release it so a subsequent call's .playAndRecord setCategory starts clean and other
    // apps are told they can resume.
    static func end() {
        let s = AVAudioSession.sharedInstance()
        try? s.setActive(false, options: .notifyOthersOnDeactivation)
    }
}
