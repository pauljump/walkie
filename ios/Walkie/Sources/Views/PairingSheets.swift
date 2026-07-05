import SwiftUI
import UIKit

// The two no-typing pairing surfaces, shared by onboarding AND Settings so re-pairing never
// forces typing either. Both end at the same sink: a PairingPayload applied through
// AppSettings. Keeping them here means the QR view and the LAN picker are written once.

// MARK: - Scan a code

// Full-screen QR viewfinder. On a successful scan it parses walkie://pair (or JSON), applies
// it, and calls onPaired. Falls back gracefully when the camera is denied or unavailable
// (Simulator) by pointing the user at the other paths.
struct ScanCodeView: View {
    @StateObject private var scanner = QRScanner()
    @ObservedObject var settings: AppSettings
    var onPaired: (PairingPayload) -> Void
    var onCancel: () -> Void

    @State private var parseFailed = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            switch scanner.access {
            case .authorized:
                CameraPreview(session: scanner.session).ignoresSafeArea()
                viewfinderOverlay
            case .denied:
                fallback(title: "Camera is off",
                         body: "Walkie can't open the camera, so it can't scan. Go back and pick your Mac on wifi, or type its address.")
            case .unavailable:
                fallback(title: "No camera here",
                         body: "This device has no camera to scan with. Go back and pick your Mac on wifi, or type its address.")
            case .unknown:
                ProgressView().tint(.white)
            }

            VStack {
                HStack {
                    Button("Cancel", action: onCancel)
                        .font(.wkBody(15, .semibold))
                        .foregroundStyle(.white)
                        .padding(12)
                    Spacer()
                }
                Spacer()
            }
        }
        .onAppear { scanner.onFound = handle; scanner.start() }
        .onDisappear { scanner.stop() }
    }

    private var viewfinderOverlay: some View {
        VStack(spacing: 18) {
            Spacer()
            RoundedRectangle(cornerRadius: 24)
                .stroke(WK.signal, lineWidth: 3)
                .frame(width: 240, height: 240)
            Text("Point at the code on your Mac's setup screen.")
                .font(.wkBody(14))
                .foregroundStyle(.white)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 30)
            if parseFailed {
                Text("That code wasn't a Walkie pairing code. Try again.")
                    .font(.wkBody(12))
                    .foregroundStyle(WK.error)
            }
            Spacer()
        }
    }

    private func fallback(title: String, body: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "camera.fill").font(.system(size: 34)).foregroundStyle(.white.opacity(0.7))
            Text(title).font(.wkDisplay(20, .bold)).foregroundStyle(.white)
            Text(body)
                .font(.wkBody(14))
                .foregroundStyle(.white.opacity(0.8))
                .multilineTextAlignment(.center)
                .padding(.horizontal, 30)
            Button("Go back", action: onCancel)
                .font(.wkBody(15, .semibold))
                .foregroundStyle(WK.bgBottom)
                .padding(.vertical, 12).padding(.horizontal, 28)
                .background(RoundedRectangle(cornerRadius: 14).fill(WK.signal))
                .padding(.top, 6)
        }
    }

    private func handle(_ raw: String) {
        guard let payload = PairingPayload.parse(raw) else {
            parseFailed = true
            // Let the user try again: clear the last scan and restart.
            scanner.scanned = nil
            scanner.start()
            return
        }
        payload.apply(to: settings)
        onPaired(payload)
    }
}

// MARK: - Pick my Mac (Bonjour)

// Lists the Macs found on wifi via LANDiscovery. Tapping one resolves host+port and applies
// it. Bonjour can't carry the secret key safely, so this fills host+port and the caller
// reminds the user to paste the short key once (or scan instead).
//
// Every state here says WHAT is happening and WHAT to do next — no infinite spinner, no
// silent empty, no dead end. The phases come straight from LANDiscovery.phase:
//   asking     → "Asking to see devices on your wifi…" (the iOS permission prompt is up)
//   searching  → "Searching your wifi for your Mac…" (a short spinner, then it times out)
//   found      → the list of Macs, tap to connect
//   empty      → "Couldn't find your Mac" with the real reasons + a way out
//   denied     → "Walkie needs permission…" with a one-tap Open Settings
struct PickMacView: View {
    @StateObject private var discovery = LANDiscovery()
    @ObservedObject var settings: AppSettings
    var onPaired: (PairingPayload) -> Void
    var onCancel: () -> Void

    @State private var resolving: String?
    @State private var resolveFailed = false

    var body: some View {
        ZStack {
            DuskBackground()
            VStack(alignment: .leading, spacing: 18) {
                header

                switch discovery.phase {
                case .asking:     asking
                case .searching:  searching
                case .found:      results
                case .empty:      empty
                case .denied:     denied
                }

                Spacer()
                Button("Go back", action: onCancel)
                    .font(.wkBody(15, .semibold))
                    .foregroundStyle(WK.textSecondary)
            }
            .padding(20)
        }
        .onAppear { discovery.start() }
        .onDisappear { discovery.stop() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Pick your Mac")
                .font(.wkDisplay(26, .bold))
                .foregroundStyle(WK.textPrimary)
            Text("The Macs on your wifi running the standup show up below.")
                .font(.wkBody(13))
                .foregroundStyle(WK.textTertiary)
        }
    }

    // MARK: States

    // The iOS "allow Walkie to find devices on your wifi" prompt is (or is about to be) up.
    private var asking: some View {
        statusBlock(
            spinner: true,
            title: "Asking to see devices on your wifi…",
            body: "iOS is asking whether Walkie can look for your Mac on this wifi. Tap Allow to keep going."
        )
    }

    // Permission granted, actively looking. Times out to .empty after ~9s so this never spins
    // forever.
    private var searching: some View {
        statusBlock(
            spinner: true,
            title: "Searching your wifi for your Mac…",
            body: "Your Mac shows up here once the standup is running on it."
        )
    }

    private var results: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Found:")
                .font(.wkBody(13, .semibold))
                .foregroundStyle(WK.textSecondary)
            ForEach(discovery.macs) { mac in
                macRow(mac)
            }
            if resolveFailed {
                Text("That Mac stopped answering. It may have gone to sleep or left the wifi. Tap it to try again, or go back and scan the code or type the address instead.")
                    .font(.wkBody(12))
                    .foregroundStyle(WK.error)
            }
        }
    }

    // Searched past the timeout and found nothing. Name the real reasons, then give two ways
    // forward: search again, or go back to scan a code / type the address.
    private var empty: some View {
        infoCard(
            icon: "magnifyingglass",
            iconColor: WK.alert,
            title: "Couldn't find your Mac on this wifi",
            lines: [
                "Is your phone on the same wifi as your Mac?",
                "Is your Mac awake, with Walkie running on it?",
                "Away from home? Turn on Tailscale, then type the address your Mac showed.",
            ],
            primaryTitle: "Search again",
            primaryAction: { discovery.retry() },
            secondaryTitle: "Scan a code or type it instead",
            secondaryAction: onCancel
        )
    }

    // The wifi permission was turned down. Say exactly that and the exact setting, with a
    // one-tap jump into Settings.
    private var denied: some View {
        infoCard(
            icon: "wifi.slash",
            iconColor: WK.error,
            title: "Walkie needs permission to see your wifi",
            lines: [
                "To find your Mac, Walkie has to look at the devices on your wifi. That permission is off.",
                "Turn it on: Settings > Walkie > Local Network.",
            ],
            primaryTitle: "Open Settings",
            primaryAction: openSettings,
            secondaryTitle: "Scan a code or type it instead",
            secondaryAction: onCancel
        )
    }

    private func macRow(_ mac: LANDiscovery.FoundMac) -> some View {
        Button {
            Task {
                resolving = mac.id
                resolveFailed = false
                if let payload = await discovery.resolve(mac) {
                    payload.apply(to: settings)   // host + port; key stays for the user to paste
                    onPaired(payload)
                } else {
                    resolveFailed = true          // stopped answering: say so, don't fail silently
                }
                resolving = nil
            }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "desktopcomputer").foregroundStyle(WK.signal)
                VStack(alignment: .leading, spacing: 2) {
                    Text(mac.displayName)
                        .font(.wkBody(15, .semibold))
                        .foregroundStyle(WK.textPrimary)
                    Text(resolving == mac.id ? "Connecting…" : "Tap to connect")
                        .font(.wkBody(12))
                        .foregroundStyle(WK.textTertiary)
                }
                Spacer()
                if resolving == mac.id {
                    ProgressView().tint(WK.signal)
                } else {
                    Image(systemName: "chevron.right").foregroundStyle(WK.textTertiary)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 16).fill(WK.surface))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(WK.hairline, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(resolving != nil)
    }

    // MARK: Reusable state blocks

    private func statusBlock(spinner: Bool, title: String, body: String) -> some View {
        VStack(spacing: 12) {
            if spinner { ProgressView().tint(WK.signal) }
            Text(title)
                .font(.wkBody(15, .semibold))
                .foregroundStyle(WK.textPrimary)
                .multilineTextAlignment(.center)
            Text(body)
                .font(.wkBody(13))
                .foregroundStyle(WK.textSecondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 28)
        .padding(.horizontal, 8)
    }

    // A titled explainer card with a bulleted "here's why" list and two clear next steps.
    private func infoCard(icon: String, iconColor: Color, title: String, lines: [String],
                          primaryTitle: String, primaryAction: @escaping () -> Void,
                          secondaryTitle: String, secondaryAction: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Image(systemName: icon).font(.system(size: 20)).foregroundStyle(iconColor)
                Text(title)
                    .font(.wkBody(16, .semibold))
                    .foregroundStyle(WK.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: 8) {
                ForEach(lines, id: \.self) { line in
                    HStack(alignment: .top, spacing: 8) {
                        Text("•").foregroundStyle(WK.textTertiary)
                        Text(line)
                            .font(.wkBody(13))
                            .foregroundStyle(WK.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            Button(action: primaryAction) {
                Text(primaryTitle)
                    .font(.wkBody(15, .semibold))
                    .foregroundStyle(WK.bgBottom)
                    .padding(.vertical, 12).frame(maxWidth: .infinity)
                    .background(RoundedRectangle(cornerRadius: 14).fill(WK.signal))
            }
            .buttonStyle(.plain)
            Button(action: secondaryAction) {
                Text(secondaryTitle)
                    .font(.wkBody(14, .semibold))
                    .foregroundStyle(WK.textSecondary)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 16).fill(WK.surface))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(WK.hairline, lineWidth: 1))
    }

    private func openSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) {
            UIApplication.shared.open(url)
        }
    }
}
