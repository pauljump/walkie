import SwiftUI

// Walkie: every coding subscription on your Mac (Claude Code, Codex, Antigravity, Grok), on your
// phone. The Mac runs the bridge (mac/ in this repo); this app pairs with it once.
@main
struct WalkieApp: App {
    @UIApplicationDelegateAdaptor(PushDelegate.self) private var pushDelegate
    @Environment(\.scenePhase) private var scenePhase
    @State private var connection = Connection.shared
    @State private var bridge = Bridge(connection: Connection.shared)
    @State private var store = Store.shared

    init() {
        #if DEBUG
        // UI tests and recordings start unpaired with `-walkieUnpair YES`.
        if UserDefaults.standard.bool(forKey: "walkieUnpair") { Connection.shared.forget() }
        // Simulator runs: `simctl launch … -walkiePair walkie://pair?…` pairs without the prompt.
        if let link = UserDefaults.standard.string(forKey: "walkiePair"), let p = PairingPayload.parse(link) {
            Connection.shared.apply(p)
        }
        #endif
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if connection.isConfigured {
                    HomeView()
                } else {
                    PairView()
                }
            }
            .environment(bridge)
            .environment(connection)
            .environment(store)
            .tint(WK.accent)
            .task {
                PushDelegate.bridge = bridge
                bridge.connect()
                store.start()
            }
            // Ask for notifications only once the Mac says it can send them (it needs an APNs key).
            .onChange(of: bridge.pushAvailable) { _, on in
                #if DEBUG
                if UserDefaults.standard.bool(forKey: "walkieNoPush") { return }
                #endif
                if on { PushDelegate.requestAuthorization() }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { bridge.foregrounded() } else if phase == .background { bridge.backgrounded() }
            }
            .onOpenURL { url in
                guard let p = PairingPayload.parse(url.absoluteString) else { return }
                connection.apply(p)
                bridge.connect()
            }
        }
    }
}
