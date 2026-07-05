import SwiftUI

// Three tabs: the Standup (your voice line with Mara), the Team Room (watch #work), and
// Settings (change your Mac or your voice later). Only the Standup tab speaks; the Team Room
// is eyes-only.
//
// On a fresh install the app used to come up offline with no guidance. Now a first-run
// walkthrough covers the whole screen until the user has pointed the app at their Mac and
// finished setup. Once finished, it never comes back on its own.
//
// The gate is driven ONLY by whether the user has completed setup (the `onboarded` flag).
// It is deliberately NOT tied to the live connection. Earlier it was `!onboarded && not
// online`, which meant the moment the broker reconnected mid-walk (say, after the phone
// woke from a pocket) the cover would flicker: SwiftUI re-evaluated the gate on every
// render and dismissed/re-presented the cover on a connection blip. Setup is a one-time
// door, not a live status light — so it opens once, on a fresh install or after Start over,
// and closes for good when the user finishes. The "is my Mac reachable?" question is
// answered inside onboarding (the readiness screen's GET /api/status) and by the Standup
// tab's own status line, never by this gate.
struct RootView: View {
    @EnvironmentObject var broker: BrokerClient
    // The single source of truth for the setup door. Set to true once, when the user finishes
    // onboarding (taps "Start walking" from readiness, or chooses "Type it instead"). Cleared
    // by Start over in Settings, which re-opens the door.
    @AppStorage("wk.onboarded") private var onboarded = false
    @State private var tab = 0

    var body: some View {
        TabView(selection: $tab) {
            StandupView()
                .tabItem { Label("Standup", systemImage: "waveform") }
                .tag(0)
            TeamRoomView()
                .tabItem { Label("Team", systemImage: "person.3.fill") }
                .tag(1)
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gear") }
                .tag(2)
        }
        .tint(WK.signal)
        // Bind directly to the persisted flag. Because the binding's get is `!onboarded` and
        // its set writes `onboarded = !newValue`, an interactive dismiss (if it ever happens)
        // and the onDone/onTypeItInstead callbacks all agree on one value — no `.constant`
        // foot-gun re-presenting the cover on an unrelated re-render.
        .fullScreenCover(isPresented: Binding(
            get: { !onboarded },
            set: { presented in onboarded = !presented }
        )) {
            OnboardingView(
                onDone: { onboarded = true },
                onTypeItInstead: {
                    // Mark setup done so the cover closes, then drop the user on Settings —
                    // the manual fallback form — to finish by hand.
                    onboarded = true
                    tab = 2
                }
            )
            .environmentObject(broker)
        }
    }
}
