import SwiftUI

// Walkie — the walking standup. You're the Director; an EM-conductor is your only
// voice; named agent reports build while you walk (talk -> build -> review).
// v0 is one screen with stubbed-but-real data so the loop can be felt before the
// Mac Mini bridge is wired. Design doc + CEO plan live in ~/.gstack/projects/.
@main
struct WalkieApp: App {
    // One shared broker connection, fanned out to both surfaces: Standup watches #standup
    // (the voice line), TeamRoom watches #work (the team room). Single source of truth for
    // the connection — neither view owns it.
    @StateObject private var broker: BrokerClient
    @StateObject private var standup: Standup
    @StateObject private var team: TeamRoom

    init() {
        // Touch AppSettings first so UserDefaults are loaded before BrokerClient seeds its
        // config from them and VoiceSession picks its speaker. Self-host: a fresh install has
        // an empty broker config, so the app comes up offline and the Settings tab invites the
        // user to enter their own Mac's host/port/key.
        _ = AppSettings.shared
        let b = BrokerClient()            // seeds from AppSettings.shared.brokerConfig
        _broker = StateObject(wrappedValue: b)
        _standup = StateObject(wrappedValue: Standup(broker: b))
        _team = StateObject(wrappedValue: TeamRoom(broker: b))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(broker)   // SettingsView hotswaps this on Save
                .environmentObject(standup)
                .environmentObject(team)
                .preferredColorScheme(.dark)
                .task { broker.connect() }   // no-op-safe when unconfigured; connects when set
                // A tapped walkie://pair link (from the QR / setup link the Mac prints) lands
                // here. Parse it, write host/port/key through the same AppSettings seam the
                // scanner uses, then hotswap the live connection so the app points at that Mac
                // right away. A garbled link that doesn't parse is ignored, not acted on.
                .onOpenURL { url in
                    guard let payload = PairingPayload.parse(url.absoluteString) else { return }
                    payload.apply(to: AppSettings.shared)
                    broker.updateConfig(AppSettings.shared.brokerConfig)
                }
        }
    }
}
