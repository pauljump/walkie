import SwiftUI

// The Settings tab — the change-it-later fallback. The first-run walkthrough is the primary
// on-ramp now; this screen is where the user re-points at a different Mac or changes their
// voice after setup. Two sections:
//
//  1. BACKEND — host / port / broker key for the user's OWN Mac, plus scan/find buttons so
//     re-pairing doesn't force typing. "Test Connection" validates before saving; Save
//     persists to AppSettings and hotswaps the live BrokerClient so the Standup + Team tabs
//     reconnect to the new target.
//  2. VOICE — the one clear VoicePicker (explicit selected state, sample with the audio fix,
//     honest "Get a voice key" link).
//
// Eyes-only: nothing here is spoken by the call loop (the preview uses its own speaker).
struct SettingsView: View {
    @EnvironmentObject var broker: BrokerClient
    @ObservedObject private var settings = AppSettings.shared

    // Local edit buffers so the user can Test before committing; Save writes them back.
    @State private var host = AppSettings.shared.brokerHost
    @State private var portText = String(AppSettings.shared.brokerPort)
    @State private var key = AppSettings.shared.brokerKey

    @State private var testState: TestUI = .idle
    @State private var savedFlash = false

    // Which no-typing pairing surface is up, if any (reuses the same sink as onboarding).
    @State private var pairing: PairingKind?

    enum TestUI: Equatable {
        case idle, testing, ok, failed(String)
    }

    // Identifiable wrapper so fullScreenCover(item:) can drive the two pairing surfaces.
    struct PairingKind: Identifiable {
        enum Kind { case scan, pick }
        let kind: Kind
        var id: String { kind == .scan ? "scan" : "pick" }
    }

    var body: some View {
        ZStack {
            DuskBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    title
                    backendSection
                    voiceSection
                    resetSection
                    Color.clear.frame(height: 80)   // keyboard-avoidance breathing room
                }
                .padding(.horizontal, 20)
                .padding(.top, 12)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .fullScreenCover(item: $pairing) { kind in
            switch kind.kind {
            case .scan:
                ScanCodeView(settings: settings,
                             onPaired: { _ in applyPairedFields(); pairing = nil },
                             onCancel: { pairing = nil })
            case .pick:
                PickMacView(settings: settings,
                            onPaired: { _ in applyPairedFields(); pairing = nil },
                            onCancel: { pairing = nil })
            }
        }
    }

    private var title: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Settings")
                .font(.wkDisplay(30, .bold))
                .foregroundStyle(WK.textPrimary)
            Text("change your Mac or your voice later")
                .font(.wkBody(13))
                .foregroundStyle(WK.textTertiary)
        }
    }

    // A scan/pick wrote host+port(+key) straight into AppSettings. Pull those into the local
    // edit buffers so the fields on screen show the new address, then hotswap the connection.
    private func applyPairedFields() {
        host = settings.brokerHost
        portText = String(settings.brokerPort)
        key = settings.brokerKey
        broker.updateConfig(settings.brokerConfig)
    }

    // MARK: - Backend

    private var backendSection: some View {
        card(title: "BACKEND", systemImage: "server.rack") {
            // Re-pair without typing: same scan / find flow as the walkthrough.
            HStack(spacing: 12) {
                Button {
                    pairing = PairingKind(kind: .scan)
                } label: {
                    pairingChip("Scan a code", systemImage: "qrcode.viewfinder")
                }
                .buttonStyle(.plain)
                Button {
                    pairing = PairingKind(kind: .pick)
                } label: {
                    pairingChip("Find my Mac", systemImage: "wifi")
                }
                .buttonStyle(.plain)
            }

            field("Your Mac's address", text: $host,
                  placeholder: "your-mac.local",
                  hint: "On the same wifi, this is usually your-mac.local. Away from home, use the address your Mac showed during setup.")
            field("Port", text: $portText, placeholder: "3889", keyboard: .numberPad)
            field("The key", text: $key,
                  placeholder: "the key your Mac showed",
                  secure: true,
                  hint: "The key that lets your phone talk to your Mac. Only your Mac and your phone know it. Paste what your Mac showed during setup.")

            HStack(spacing: 12) {
                Button(action: testConnection) {
                    HStack(spacing: 8) {
                        if testState == .testing { ProgressView().tint(WK.bgBottom) }
                        Text(testState == .testing ? "Testing…" : "Test Connection")
                            .font(.wkBody(14, .semibold))
                    }
                    .foregroundStyle(WK.bgBottom)
                    .padding(.vertical, 11).frame(maxWidth: .infinity)
                    .background(RoundedRectangle(cornerRadius: 14).fill(WK.signal))
                }
                .buttonStyle(.plain)
                .disabled(testState == .testing)

                Button(action: saveBackend) {
                    Text(savedFlash ? "Saved ✓" : "Save")
                        .font(.wkBody(14, .semibold))
                        .foregroundStyle(WK.textPrimary)
                        .padding(.vertical, 11).frame(maxWidth: .infinity)
                        .background(RoundedRectangle(cornerRadius: 14).fill(WK.surfaceHi))
                        .overlay(RoundedRectangle(cornerRadius: 14).stroke(WK.hairline, lineWidth: 1))
                }
                .buttonStyle(.plain)
            }

            testStatusRow
        }
    }

    @ViewBuilder private var testStatusRow: some View {
        switch testState {
        case .idle:
            EmptyView()
        case .testing:
            statusLabel("Reaching your Mac…", color: WK.textTertiary, systemImage: "hourglass")
        case .ok:
            statusLabel("Connected", color: WK.shipped, systemImage: "checkmark.circle.fill")
        case .failed(let msg):
            statusLabel(msg, color: WK.error, systemImage: "xmark.circle.fill")
        }
    }

    // MARK: - Voice

    // One clear picker (VoicePicker) instead of the old muddy 3-way segmented toggle. It owns
    // the rows, the BYO key field, the sample (with the audio fix), and the "Get a voice key"
    // link.
    private var voiceSection: some View {
        card(title: "VOICE", systemImage: "waveform") {
            VoicePicker(settings: settings)
        }
    }

    // MARK: - Start over

    // Forget this phone's setup and bring back the first-run walkthrough. Useful for re-pairing
    // to a different Mac, or just to see the walkthrough again. Nothing on the Mac is touched.
    private var resetSection: some View {
        card(title: "START OVER", systemImage: "arrow.counterclockwise") {
            Text("Forget this Mac and show the setup walkthrough again. Your team and your keys live on your Mac and are left alone. This only resets the phone.")
                .font(.wkBody(13))
                .foregroundStyle(WK.textSecondary)
            Button(action: startOver) {
                Text("Start over")
                    .font(.wkBody(14, .semibold))
                    .foregroundStyle(WK.error)
                    .padding(.vertical, 11).frame(maxWidth: .infinity)
                    .background(RoundedRectangle(cornerRadius: 14).fill(WK.surfaceHi))
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(WK.error.opacity(0.4), lineWidth: 1))
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: - Actions

    private func candidateConfig() -> BrokerConfig {
        BrokerConfig(
            host: host.trimmingCharacters(in: .whitespaces),
            port: Int(portText) ?? 3889,
            apiKey: key.trimmingCharacters(in: .whitespaces),
            postChannel: "standup",
            listenChannels: ["standup", "work"]
        )
    }

    private func testConnection() {
        testState = .testing
        let cfg = candidateConfig()
        Task {
            let result = await BrokerClient.testConnection(cfg)
            switch result {
            case .ok:              testState = .ok
            case .unauthorized:    testState = .failed("Reached your Mac, but the key doesn't match. Re-check the key your Mac showed.")
            case .unreachable(let m): testState = .failed("Couldn't reach your Mac. Same wifi, or Tailscale on? (\(m))")
            }
        }
    }

    private func saveBackend() {
        settings.brokerHost = host.trimmingCharacters(in: .whitespaces)
        settings.brokerPort = Int(portText) ?? 3889
        settings.brokerKey  = key.trimmingCharacters(in: .whitespaces)
        broker.updateConfig(settings.brokerConfig)   // hotswap + reconnect
        savedFlash = true
        Task { try? await Task.sleep(nanoseconds: 1_400_000_000); savedFlash = false }
    }

    // Clear this phone's setup and go offline. Clearing the onboarded flag flips RootView's
    // gate (which is driven only by that flag now) so the first-run walkthrough re-presents
    // over everything. Disconnecting the broker just leaves the app offline until the user
    // points it at a Mac again — it is not part of the gate.
    private func startOver() {
        settings.reset()
        host = ""
        portText = "3889"
        key = ""
        testState = .idle
        broker.updateConfig(settings.brokerConfig)   // empty config -> disconnect, stay offline
    }

    // MARK: - Reusable bits

    // Small chip button for the "Scan a code" / "Find my Mac" re-pair shortcuts.
    private func pairingChip(_ label: String, systemImage: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: systemImage)
            Text(label).font(.wkBody(13, .semibold))
        }
        .foregroundStyle(WK.signal)
        .padding(.vertical, 10).frame(maxWidth: .infinity)
        .background(RoundedRectangle(cornerRadius: 12).fill(WK.inputBg))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(WK.inputBorder, lineWidth: 1))
    }

    private func card<Content: View>(title: String, systemImage: String,
                                     @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                Image(systemName: systemImage).font(.system(size: 13, weight: .semibold))
                Text(title).font(.wkBody(12, .semibold)).tracking(1.2)
            }
            .foregroundStyle(WK.textTertiary)
            content()
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WK.rCard).fill(WK.surface))
        .overlay(RoundedRectangle(cornerRadius: WK.rCard).stroke(WK.hairline, lineWidth: 1))
    }

    private func field(_ label: String, text: Binding<String>, placeholder: String,
                       secure: Bool = false, keyboard: UIKeyboardType = .default,
                       hint: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.wkBody(12, .medium)).foregroundStyle(WK.textSecondary)
            Group {
                if secure {
                    SecureField(placeholder, text: text)
                } else {
                    TextField(placeholder, text: text)
                        .keyboardType(keyboard)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                }
            }
            .font(.wkBody(15))
            .foregroundStyle(WK.textPrimary)
            .padding(.horizontal, 14).padding(.vertical, 12)
            .background(RoundedRectangle(cornerRadius: 12).fill(WK.inputBg))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(WK.inputBorder, lineWidth: 1))
            // A plain "what is this / why" line under the field, so a non-technical user knows
            // what to type and a technical user isn't left guessing at our terms.
            if let hint {
                Text(hint)
                    .font(.wkBody(11))
                    .foregroundStyle(WK.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func statusLabel(_ text: String, color: Color, systemImage: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: systemImage)
            Text(text).font(.wkBody(13))
            Spacer()
        }
        .foregroundStyle(color)
    }
}
