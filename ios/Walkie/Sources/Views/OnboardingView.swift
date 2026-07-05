import SwiftUI

// The first-run gate. A fresh install used to come up offline with no guidance except "go to
// Settings," so the first thing a new user saw was an empty form. This flow points the app at
// the user's Mac once, with no typing when possible, then proves it works before they set out.
//
// Four steps: welcome, connect (scan or pick, with "type it instead" as the fallback), an
// optional Tailscale explainer they can skip, and a readiness check. It shows until connected
// and is dismissed once, so a returning, already-configured user never sees it again.
struct OnboardingView: View {
    @EnvironmentObject var broker: BrokerClient
    @ObservedObject private var settings = AppSettings.shared

    // Called when the user taps "Start walking" from the readiness step.
    var onDone: () -> Void
    // Opens the manual fallback (Settings). RootView wires this to switch to the Settings tab.
    var onTypeItInstead: () -> Void

    enum Step { case welcome, connect, tailscale, readiness }
    @State private var step: Step = .welcome

    // Which pairing surface is up, if any.
    enum Pairing { case scan, pick }
    @State private var pairing: Pairing?

    var body: some View {
        ZStack {
            DuskBackground()
            content
        }
        .fullScreenCover(item: Binding(
            get: { pairing.map { PairingKind(kind: $0) } },
            set: { pairing = $0?.kind }
        )) { kind in
            switch kind.kind {
            case .scan:
                ScanCodeView(settings: settings,
                             onPaired: { _ in pairing = nil; step = .tailscale },
                             onCancel: { pairing = nil })
            case .pick:
                PickMacView(settings: settings,
                            onPaired: { _ in pairing = nil; step = .tailscale },
                            onCancel: { pairing = nil })
            }
        }
    }

    // Small Identifiable wrapper so fullScreenCover(item:) can drive the two surfaces.
    private struct PairingKind: Identifiable {
        let kind: Pairing
        var id: String { kind == .scan ? "scan" : "pick" }
    }

    @ViewBuilder private var content: some View {
        switch step {
        case .welcome:   welcome
        case .connect:   connect
        case .tailscale: tailscale
        case .readiness: readiness
        }
    }

    // MARK: - 1. Welcome

    private var welcome: some View {
        VStack(alignment: .leading, spacing: 18) {
            Spacer()
            Image(systemName: "figure.walk.motion")
                .font(.system(size: 44))
                .foregroundStyle(WK.signal)
            Text("Walkie runs on your own Mac.")
                .font(.wkDisplay(30, .bold))
                .foregroundStyle(WK.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            Text("You point the app at it once, then you talk.")
                .font(.wkBody(16))
                .foregroundStyle(WK.textSecondary)
            Text("Your AI key stays on your Mac. You never put it on your phone.")
                .font(.wkBody(14))
                .foregroundStyle(WK.textTertiary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
            primaryButton("Connect my Mac") { step = .connect }
        }
        .padding(28)
    }

    // MARK: - 2. Connect

    private var connect: some View {
        VStack(alignment: .leading, spacing: 16) {
            stepHeader("Connect my Mac",
                       "Your Mac shows a code when the standup is running. Point your phone at it, or pick your Mac off your wifi. No address to type.")

            connectCard(
                title: "Scan the code",
                body: "Open the camera on the code your Mac shows. It fills the address and the key in one tap.",
                systemImage: "qrcode.viewfinder"
            ) { pairing = .scan }

            connectCard(
                title: "Pick my Mac",
                body: "Find your Mac on this wifi and tap it. It fills the address. Then you paste the pairing key once, which your Mac showed during setup. That's the secret that lets your phone talk to your Mac. It is not your AI key, which stays on the Mac.",
                systemImage: "wifi"
            ) { pairing = .pick }

            Spacer()

            Button(action: onTypeItInstead) {
                Text("Type it instead")
                    .font(.wkBody(14, .semibold))
                    .foregroundStyle(WK.textTertiary)
            }
            .frame(maxWidth: .infinity)
        }
        .padding(24)
    }

    private func connectCard(title: String, body: String, systemImage: String,
                             action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 14) {
                Image(systemName: systemImage)
                    .font(.system(size: 26))
                    .foregroundStyle(WK.signal)
                    .frame(width: 34)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(.wkBody(17, .semibold))
                        .foregroundStyle(WK.textPrimary)
                    Text(body)
                        .font(.wkBody(13))
                        .foregroundStyle(WK.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: WK.rCard).fill(WK.surface))
            .overlay(RoundedRectangle(cornerRadius: WK.rCard).stroke(WK.hairline, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    // MARK: - 3. Tailscale (optional, skippable)

    @State private var tailscaleExpanded = false

    private var tailscale: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                stepHeader("Keep it working on a walk",
                           "On your home wifi the phone and your Mac already find each other. The moment you leave the house the phone loses your Mac. Tailscale is a private tunnel between them, so Walkie keeps working when you walk out the door.")

                Button {
                    withAnimation { tailscaleExpanded.toggle() }
                } label: {
                    HStack {
                        Text(tailscaleExpanded ? "Hide the steps" : "Show me how")
                            .font(.wkBody(15, .semibold))
                            .foregroundStyle(WK.signal)
                        Image(systemName: tailscaleExpanded ? "chevron.up" : "chevron.down")
                            .foregroundStyle(WK.signal)
                    }
                }
                .buttonStyle(.plain)

                if tailscaleExpanded { tailscaleSteps }

                Spacer(minLength: 20)

                primaryButton("I'll add this later") { step = .readiness }
            }
            .padding(24)
        }
    }

    private var tailscaleSteps: some View {
        VStack(alignment: .leading, spacing: 10) {
            tailscaleStep("1", "On your Mac, install it: run brew install tailscale in Terminal.")
            tailscaleStep("2", "Sign in on the Mac: run tailscale up and log in.")
            tailscaleStep("3", "Get the Tailscale app on this phone and sign in with the same account.")
            tailscaleStep("4", "Re-run the setup on your Mac. It prints a new code that uses the tunnel address, so Walkie reaches your Mac from anywhere.")
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WK.rCard).fill(WK.surface))
        .overlay(RoundedRectangle(cornerRadius: WK.rCard).stroke(WK.hairline, lineWidth: 1))
    }

    private func tailscaleStep(_ n: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(n)
                .font(.wkBody(13, .bold))
                .foregroundStyle(WK.bgBottom)
                .frame(width: 22, height: 22)
                .background(Circle().fill(WK.signal))
            Text(text)
                .font(.wkBody(13))
                .foregroundStyle(WK.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - 4. Readiness

    private var readiness: some View {
        VStack(alignment: .leading, spacing: 16) {
            stepHeader("Let's make sure it's ready",
                       "Walkie checks your Mac before you set out.")
            ReadinessView(
                onReady: onDone,
                onFix: onTypeItInstead
            )
            Spacer()
        }
        .padding(24)
    }

    // MARK: - Reusable bits

    private func stepHeader(_ title: String, _ subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.wkDisplay(26, .bold))
                .foregroundStyle(WK.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            Text(subtitle)
                .font(.wkBody(15))
                .foregroundStyle(WK.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func primaryButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.wkBody(16, .semibold))
                .foregroundStyle(WK.bgBottom)
                .padding(.vertical, 15).frame(maxWidth: .infinity)
                .background(RoundedRectangle(cornerRadius: 16).fill(WK.signal))
        }
        .buttonStyle(.plain)
    }
}
