import Foundation
import Speech
import AVFoundation

// Continuous on-device speech-to-text — the "ears" of the hands-free call. No button:
// the engine listens, and when you pause (~1.3s of silence) the utterance is emitted as
// a Director message and the buffer cycles for the next one. pause()/resume() give us
// half-duplex: while Mara is speaking we deafen the mic so she never transcribes herself.
// On-device SFSpeechRecognizer; on the simulator the mic may be unavailable and the app
// degrades gracefully (available = false).
@MainActor
final class SpeechRecognizer: ObservableObject {
    @Published var partial = ""          // live transcript of the current utterance
    @Published var isListening = false   // engine running AND not paused
    @Published var available = true

    // Fired when a complete utterance is detected (a pause after speech).
    var onUtterance: ((String) -> Void)?

    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private let engine = AVAudioEngine()
    private var silence: Timer?
    private let silenceWindow: TimeInterval = 1.3
    private var running = false           // intent to listen (survives pause/resume)

    // Begin (or resume intent to) listening. Requests auth on first call.
    func startListening() {
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                guard status == .authorized else { self.available = false; return }
                self.running = true
                self.beginEngine()
            }
        }
    }

    // Stop entirely — ends the call's listening.
    func stopListening() {
        running = false
        teardown()
    }

    // Half-duplex mute: stop capturing while Mara speaks, keep the intent to listen.
    func pause() {
        guard running else { return }
        teardown()
    }

    func resume() {
        guard running else { return }
        beginEngine()
    }

    // MARK: - Engine

    private func beginEngine() {
        guard let recognizer, recognizer.isAvailable else { available = false; return }
        guard !engine.isRunning else { return }
        partial = ""
        do {
            // .playAndRecord so TTS playback and capture share one session; .voiceChat
            // turns on the system's echo cancellation (helps now, eases full-duplex later).
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .voiceChat,
                                    options: [.duckOthers, .allowBluetooth, .defaultToSpeaker])
            try session.setActive(true, options: .notifyOthersOnDeactivation)

            let node = engine.inputNode
            let format = node.outputFormat(forBus: 0)
            node.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
                self?.request?.append(buffer)
            }
            engine.prepare()
            try engine.start()
            isListening = true
            startTask()
        } catch {
            available = false
            teardown()
        }
    }

    // A fresh recognition request/task. Cycled per utterance so each one starts clean
    // and we don't hit SFSpeech's ~1-minute single-request ceiling on a long walk.
    private func startTask() {
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        request = req
        task = recognizer?.recognitionTask(with: req) { [weak self] result, error in
            guard let self else { return }
            if let result {
                self.partial = result.bestTranscription.formattedString
                self.armSilence()   // each new word resets the pause clock
            }
            if error != nil { self.cycleTask() }
        }
    }

    // Pause detected: emit the utterance and roll a clean task for the next one.
    private func armSilence() {
        silence?.invalidate()
        silence = Timer.scheduledTimer(withTimeInterval: silenceWindow, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.flush() }
        }
    }

    private func flush() {
        let said = partial.trimmingCharacters(in: .whitespacesAndNewlines)
        cycleTask()
        guard !said.isEmpty else { return }
        onUtterance?(said)
    }

    private func cycleTask() {
        silence?.invalidate(); silence = nil
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        partial = ""
        if engine.isRunning { startTask() }   // keep the mic hot for the next utterance
    }

    private func teardown() {
        silence?.invalidate(); silence = nil
        if engine.isRunning {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        partial = ""
        isListening = false
    }
}
