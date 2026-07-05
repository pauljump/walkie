import Foundation

// "Is my Mac actually ready?" — the honest check behind the readiness screen. It GETs
// /api/status on your Mac's broker, which LocalBus serves unauthenticated (readiness only,
// no secrets) and which reports what's set up and what's missing. This is a different, more
// honest probe than the Settings "Test Connection" button: that one POSTs an empty ping to
// prove the address + key work; this one reads the broker's own view of whether the voice
// key and sandbox are in place before you set out on a walk.
@MainActor
final class Readiness: ObservableObject {
    enum Status: Equatable {
        case checking
        case ready
        case notReady(missing: [String])
    }

    @Published private(set) var status: Status = .checking
    // Positive confirmations to show on the "ready" screen, so the user sees WHERE things live —
    // above all that the AI key sits on the Mac, not the phone (a real beta user was confused by
    // this). Populated from the backend's positive flags; empty on the reachable-but-unflagged path.
    @Published private(set) var confirmations: [String] = []

    // Shape of the backend's /api/status body. Only the fields the phone acts on are decoded;
    // unknown fields are ignored so the contract can grow without breaking the app. maraReady =
    // the AI key is set on the Mac; sandboxReady = the practice project exists.
    private struct StatusBody: Decodable {
        let ok: Bool?
        let ready: Bool?
        let needs: [String]?
        let maraReady: Bool?
        let sandboxReady: Bool?
    }

    func check(_ cfg: BrokerConfig) async {
        status = .checking
        confirmations = []

        guard cfg.isConfigured, let url = cfg.statusURL else {
            status = .notReady(missing: ["Your Mac's address isn't set yet. Go back and scan the code, pick your Mac, or type its address."])
            return
        }

        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.timeoutInterval = 6
        // /api/status is unauthenticated on LocalBus, but send the key anyway so a stricter
        // broker can answer 401/403 and we map it to a bad-key message.
        req.setValue(cfg.apiKey, forHTTPHeaderField: "x-api-key")

        do {
            let (data, resp) = try await URLSession(configuration: .default).data(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0

            if code == 401 || code == 403 {
                status = .notReady(missing: ["Reached your Mac, but the key doesn't match. Re-check the key your Mac showed and enter it again."])
                return
            }
            guard (200..<300).contains(code) else {
                status = .notReady(missing: ["Couldn't reach your Mac. Is it on the same wifi as your phone, or is Tailscale on?"])
                return
            }

            let body = try? JSONDecoder().decode(StatusBody.self, from: data)
            // Build the positive confirmations from whichever flags the backend set, so the ready
            // screen can show WHERE things live. "AI key: set on your Mac" is the load-bearing one.
            confirmations = readyConfirmations(from: body)
            // If the broker explicitly reports ready, trust it. Otherwise surface its needs[]
            // list verbatim (already human-readable from the backend), or fall back to a plain
            // "not yet" if it answered 200 but said nothing useful.
            if body?.ready == true {
                status = .ready
            } else if let needs = body?.needs, !needs.isEmpty {
                status = .notReady(missing: needs)
            } else if body?.ok == true {
                // Bus is up and reachable but not flagged ready and gave no needs: reachable
                // is the meaningful signal for the phone, so treat it as ready.
                status = .ready
            } else {
                status = .notReady(missing: ["Your Mac answered but isn't ready yet. Make sure the standup is running on it, then check again."])
            }
        } catch {
            status = .notReady(missing: ["Couldn't reach your Mac. Is it on the same wifi as your phone, or is Tailscale on?"])
        }
    }

    // Turn the backend's positive flags into plain confirmation lines. When the backend gives no
    // flags (older broker, or the reachable-but-unflagged 200 path) this is empty and the ready
    // screen simply shows its headline — we never invent a ✓ we can't stand behind.
    private func readyConfirmations(from body: StatusBody?) -> [String] {
        guard let body else { return [] }
        var lines: [String] = []
        if body.maraReady == true { lines.append("AI key: set on your Mac") }
        if body.sandboxReady == true { lines.append("Practice project: ready") }
        return lines
    }
}
