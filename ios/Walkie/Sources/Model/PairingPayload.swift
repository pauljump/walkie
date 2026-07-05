import Foundation

// The one thing a scan or a picked Mac produces: the three fields the app needs to reach
// your Mac (host, port, the broker key). Both the QR scanner and the Bonjour picker end
// here, so "fills the address with no typing" has a single place it lands.
//
// The Mac's installer prints a QR that encodes `walkie://pair?host=..&port=..&key=..`
// (the backend setup wizard prints it). That URL is human-legible, so it's the
// preferred form; a raw JSON string {"host","port","key"} is also accepted so a QR made
// by another tool still works.
struct PairingPayload: Codable {
    var host: String
    var port: Int
    var key: String

    // Parse either the walkie://pair URL the Mac prints, or a raw JSON object. Returns nil
    // if neither form yields a usable host — an empty host means "not a pairing code."
    static func parse(_ scanned: String) -> PairingPayload? {
        let text = scanned.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if let fromURL = parseURL(text) { return fromURL }
        return parseJSON(text)
    }

    // walkie://pair?host=<h>&port=<p>&key=<k> — the legible form the installer prints.
    private static func parseURL(_ text: String) -> PairingPayload? {
        guard let comps = URLComponents(string: text),
              comps.scheme?.lowercased() == "walkie" else { return nil }
        // Accept walkie://pair and walkie:pair (host slot vs path slot across encoders).
        let isPair = (comps.host?.lowercased() == "pair") || (comps.path.lowercased().contains("pair"))
        guard isPair else { return nil }
        let items = comps.queryItems ?? []
        func value(_ name: String) -> String {
            (items.first { $0.name == name }?.value ?? "").trimmingCharacters(in: .whitespaces)
        }
        let host = value("host")
        guard !host.isEmpty else { return nil }
        let port = Int(value("port")) ?? 3889
        let key = value("key")
        return PairingPayload(host: host, port: port, key: key)
    }

    // Raw JSON {"host":..,"port":..,"key":..} — the fallback form.
    private static func parseJSON(_ text: String) -> PairingPayload? {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let host = ((obj["host"] as? String) ?? "").trimmingCharacters(in: .whitespaces)
        guard !host.isEmpty else { return nil }
        let port = (obj["port"] as? Int) ?? Int((obj["port"] as? String) ?? "") ?? 3889
        let key = ((obj["key"] as? String) ?? "").trimmingCharacters(in: .whitespaces)
        return PairingPayload(host: host, port: port, key: key)
    }

    // Write through the existing AppSettings seam — no typing, no new persistence path.
    // Ignores an empty host so a garbled scan can't blank a working config; leaves the
    // current key in place if this payload didn't carry one (Bonjour fills host+port only).
    @MainActor
    func apply(to settings: AppSettings) {
        let h = host.trimmingCharacters(in: .whitespaces)
        guard !h.isEmpty else { return }
        settings.brokerHost = h
        settings.brokerPort = port > 0 ? port : 3889
        let k = key.trimmingCharacters(in: .whitespaces)
        if !k.isEmpty { settings.brokerKey = k }
    }
}
