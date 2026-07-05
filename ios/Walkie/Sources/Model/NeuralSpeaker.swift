import Foundation
import AVFoundation

// Neural (cloud) voices behind the same Speaker seam SystemSpeaker uses. Two modes:
//
//  • BYOVoiceSpeaker — the user brings their OWN ElevenLabs/Cartesia key. The key is NOT
//    sent to us: it rides to the user's own conductor /tts proxy on their Mac (same host as
//    the broker), which does the synthesis and returns audio. This keeps Walkie self-host —
//    no third party in the loop but the user's own machine and their own TTS provider.
//
//  • PremiumSpeaker — a Stripe-gated stub. Locked until the user subscribes; payment is
//    stubbed in this build, so it never actually speaks — it just reports it's locked.
//
// Both degrade gracefully: any network/auth/decode failure falls back to SystemSpeaker so
// the call never goes silent. Same isSpeaking + onFinish contract as SystemSpeaker.

@MainActor
final class BYOVoiceSpeaker: NSObject, Speaker {
    @Published private(set) var isSpeaking = false
    var onFinish: (() -> Void)?
    let voiceMode: SpeakerMode = .byoVoice

    // Where to POST text for synthesis: the user's conductor /tts endpoint, derived from the
    // same broker host they configured (their Mac). The provider key travels in a header.
    private let ttsURL: URL?
    private let apiKey: String

    // On any failure we hand the line to on-device synthesis so the user still hears the reply.
    private let fallback = SystemSpeaker()

    private var player: AVAudioPlayer?
    private let session = URLSession(configuration: .default)

    init(brokerConfig: BrokerConfig, apiKey: String) {
        self.ttsURL = brokerConfig.httpBase?.appendingPathComponent("tts")
        self.apiKey = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        super.init()
        // Route the fallback's completion through our own onFinish so the call loop resumes.
        fallback.onFinish = { [weak self] in
            self?.isSpeaking = false
            self?.onFinish?()
        }
    }

    func speak(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { onFinish?(); return }

        // Missing config → graceful fallback to the robot voice (never silent).
        guard let ttsURL, !apiKey.isEmpty else { return fallbackSpeak(t) }

        isSpeaking = true
        var req = URLRequest(url: ttsURL)
        req.httpMethod = "POST"
        req.timeoutInterval = 20
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.setValue(apiKey, forHTTPHeaderField: "x-tts-key")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["text": t])

        session.dataTask(with: req) { [weak self] data, resp, err in
            Task { @MainActor in
                guard let self else { return }
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                guard err == nil, (200..<300).contains(code), let data, !data.isEmpty else {
                    // Network error, auth failure, or empty audio → fall back so we stay audible.
                    self.fallbackSpeak(t)
                    return
                }
                self.play(data, originalText: t)
            }
        }.resume()
    }

    func stop() {
        player?.stop()
        player = nil
        fallback.stop()
        isSpeaking = false
    }

    // MARK: - Playback

    private func play(_ data: Data, originalText: String) {
        do {
            let p = try AVAudioPlayer(data: data)
            p.delegate = self
            player = p
            isSpeaking = true
            p.play()
        } catch {
            // Undecodable audio → fall back rather than drop the line.
            fallbackSpeak(originalText)
        }
    }

    private func fallbackSpeak(_ text: String) {
        isSpeaking = true          // fallback.onFinish flips this back + fires our onFinish
        fallback.speak(text)
    }
}

extension BYOVoiceSpeaker: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_ p: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            self.isSpeaking = false
            self.player = nil
            self.onFinish?()
        }
    }
    nonisolated func audioPlayerDecodeErrorDidOccur(_ p: AVAudioPlayer, error: Error?) {
        Task { @MainActor in
            self.isSpeaking = false
            self.player = nil
            self.onFinish?()
        }
    }
}

// Locked stub. Premium voices are gated behind a subscription; until Stripe is wired and the
// user has paid, this speaker never actually speaks — speak() is a no-op that immediately
// hands the floor back so the call loop doesn't stall. The Settings tab shows the lock + an
// "upgrade" button; VoiceSession also refuses to mount this mode while locked (belt + braces).
@MainActor
final class PremiumSpeaker: NSObject, Speaker {
    @Published private(set) var isSpeaking = false
    var onFinish: (() -> Void)?
    let voiceMode: SpeakerMode = .premium

    // Surfaced to the UI if someone tries to activate premium without a subscription.
    static let lockedMessage = "Premium voices unlock with a Stripe subscription."

    func speak(_ text: String) {
        // No-op while locked — return the floor immediately so nothing hangs.
        isSpeaking = false
        onFinish?()
    }

    func stop() { isSpeaking = false }
}
