import SwiftUI

// First run: connect to the bridge on your Mac. `walkie pair` on the Mac prints a QR and a
// walkie://pair link; scanning, tapping, or pasting any of them fills everything in.
struct PairView: View {
    @Environment(Connection.self) private var connection
    @Environment(Bridge.self) private var bridge
    @State private var scanning = false
    @State private var manualHost = ""
    @State private var manualPort = "3889"
    @State private var manualKey = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Every AI coding subscription you pay for, in one app.")
                            .font(.title3.weight(.semibold))
                        Text("Claude Code, Codex, Antigravity and Grok run on your Mac, on your own logins. Walkie is the phone in front of them.")
                            .font(.subheadline).foregroundStyle(WK.textSecondary)
                        Text("On your Mac: `curl -fsSL https://walkie.cc/install.sh | bash`, then scan the code it prints.")
                            .font(.footnote).foregroundStyle(WK.textTertiary)
                    }
                    .padding(.vertical, 6)
                    Button { scanning = true } label: { Label("Scan pairing code", systemImage: "qrcode.viewfinder") }
                    Button {
                        if let s = UIPasteboard.general.string, let p = PairingPayload.parse(s) { pair(p) }
                        else { error = "The clipboard doesn't hold a walkie://pair link." }
                    } label: { Label("Paste pairing link", systemImage: "doc.on.clipboard") }
                }
                Section("Or enter it") {
                    TextField("Mac address (Tailscale name or IP)", text: $manualHost)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Port", text: $manualPort).keyboardType(.numberPad)
                    SecureField("Key", text: $manualKey)
                    Button("Connect") {
                        pair(PairingPayload(host: manualHost.trimmingCharacters(in: .whitespaces), port: Int(manualPort) ?? 3889, key: manualKey))
                    }
                    .disabled(manualHost.isEmpty || manualKey.isEmpty)
                }
                Section {
                    Button { connection.startDemo(); bridge.connect() } label: { Label("See it work without a Mac", systemImage: "play.circle") }
                } footer: { Text("A built-in demo with sample conversations. Nothing leaves your phone.") }
                if let error {
                    Section { Text(error).foregroundStyle(WK.error) }
                }
            }
            .navigationTitle("Walkie")
            .sheet(isPresented: $scanning) {
                ScanSheet { code in
                    scanning = false
                    if let p = PairingPayload.parse(code) { pair(p) } else { error = "That code isn't a Walkie pairing code." }
                }
            }
        }
    }

    private func pair(_ p: PairingPayload) {
        error = nil
        connection.apply(p)
        bridge.connect()
    }
}

struct ScanSheet: View {
    let onCode: (String) -> Void
    @StateObject private var scanner = QRScanner()

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            switch scanner.access {
            case .authorized: CameraPreview(session: scanner.session).ignoresSafeArea()
            case .denied: Text("Camera access is off. Enable it in Settings, or paste the link instead.").multilineTextAlignment(.center).padding()
            case .unavailable: Text("No camera available. Paste the link instead.").padding()
            case .unknown: ProgressView()
            }
        }
        .onAppear {
            scanner.onFound = onCode
            scanner.start()
        }
        .onDisappear { scanner.stop() }
    }
}
