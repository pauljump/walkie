import Foundation
import Combine

// The one place on-device config lives. Walkie is self-host: the backend runs on the
// USER'S OWN Mac, so nothing here can be hardcoded to any one person's machine. On first
// launch every field is empty — the user enters their own broker host/port/key on the
// Settings tab, and picks a voice mode. Persisted to UserDefaults (survives restarts +
// backgrounding; lives in the app sandbox, not the bundle). API keys are a candidate to
// migrate to Keychain later — the seam here (all reads/writes go through this type) makes
// that a one-file change.
//
// Single source of truth: BrokerClient reads brokerConfig; VoiceSession reads voiceMode;
// SettingsView is the only editor. @Published so SwiftUI re-renders on change.
@MainActor
final class AppSettings: ObservableObject {
    static let shared = AppSettings()

    // MARK: Broker (backend address + client-auth key)
    @Published var brokerHost: String { didSet { save() } }
    @Published var brokerPort: Int    { didSet { save() } }
    @Published var brokerKey: String  { didSet { save() } }

    // MARK: Voice
    @Published var voiceMode: SpeakerMode { didSet { save() } }
    // BYO neural-voice key (ElevenLabs / Cartesia). Sent to the user's OWN conductor /tts
    // proxy on their Mac — never to us. Empty until the user opts into BYO.
    @Published var voiceApiKey: String { didSet { save() } }

    // The broker's listen/post channels are fixed by the protocol, not user config.
    private let postChannel = "standup"
    private let listenChannels = ["standup", "work"]

    // Assemble the live broker target from the user's fields. Empty host = not configured
    // yet (BrokerClient will simply stay offline until the user fills it in on Settings).
    var brokerConfig: BrokerConfig {
        BrokerConfig(
            host: brokerHost,
            port: brokerPort,
            apiKey: brokerKey,
            postChannel: postChannel,
            listenChannels: listenChannels
        )
    }

    var isBrokerConfigured: Bool {
        !brokerHost.trimmingCharacters(in: .whitespaces).isEmpty && brokerPort > 0
    }

    // MARK: Persistence

    private enum K {
        static let host = "wk.broker.host"
        static let port = "wk.broker.port"
        static let key  = "wk.broker.key"
        static let voiceMode = "wk.voice.mode"
        static let voiceKey  = "wk.voice.apiKey"
    }

    private let store: UserDefaults

    // `store` is injectable so tests/previews can pass an isolated suite. Production uses
    // .standard via the shared singleton.
    init(store: UserDefaults = .standard) {
        self.store = store
        // decodeIfPresent-style safe reads: any missing key falls back to a sane empty
        // default so a fresh install (or a future added field) never crashes or wipes.
        brokerHost = store.string(forKey: K.host) ?? ""
        let savedPort = store.integer(forKey: K.port)          // 0 if absent
        brokerPort = savedPort > 0 ? savedPort : 3889          // default port, empty host
        brokerKey = store.string(forKey: K.key) ?? ""
        voiceMode = SpeakerMode(rawValue: store.string(forKey: K.voiceMode) ?? "") ?? .robot
        voiceApiKey = store.string(forKey: K.voiceKey) ?? ""
    }

    private func save() {
        store.set(brokerHost, forKey: K.host)
        store.set(brokerPort, forKey: K.port)
        store.set(brokerKey, forKey: K.key)
        store.set(voiceMode.rawValue, forKey: K.voiceMode)
        store.set(voiceApiKey, forKey: K.voiceKey)
    }

    // Forget this phone's setup: clear the saved Mac + voice choices and the onboarded flag.
    // Clearing the onboarded flag is what re-presents RootView's first-run walkthrough — the
    // gate is driven by that flag alone. Nothing on the user's Mac is touched: their team and
    // their keys live there, untouched. The caller disconnects the broker after this so the
    // app is simply offline until the user points it at a Mac again.
    func reset() {
        brokerHost = ""
        brokerPort = 3889
        brokerKey = ""
        voiceMode = .robot
        voiceApiKey = ""
        store.removeObject(forKey: "wk.onboarded")   // matches RootView's @AppStorage key
    }
}
