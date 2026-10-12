import Foundation
import Observation

// Where the Mac bridge lives. Host/port sit in UserDefaults, the key in the Keychain; the storage
// keys are the ones Walkie 1.x used, so an already-paired phone keeps working after the update.
@MainActor
@Observable
final class Connection {
    static let shared = Connection()

    private enum K {
        static let host = "wk.broker.host"
        static let port = "wk.broker.port"
        static let key = "wk.broker.key"
    }

    var host: String { didSet { defaults.set(host, forKey: K.host) } }
    var port: Int { didSet { defaults.set(port, forKey: K.port) } }
    var key: String { didSet { secure.write(key, account: K.key) } }

    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let secure: SecureStoring

    init(defaults: UserDefaults = .standard, secure: SecureStoring = KeychainSecureStore.shared) {
        self.defaults = defaults
        self.secure = secure
        host = defaults.string(forKey: K.host) ?? ""
        let savedPort = defaults.integer(forKey: K.port)
        port = savedPort > 0 ? savedPort : 3889
        key = secure.read(K.key) ?? ""
    }

    var isConfigured: Bool { !host.trimmingCharacters(in: .whitespaces).isEmpty && !key.isEmpty }
    /// The built-in demo (Demo.swift): no Mac, canned answers, nothing leaves the phone.
    var isDemo: Bool { host == Demo.host }
    func startDemo() { apply(PairingPayload(host: Demo.host, port: 0, key: "demo")) }

    var httpBase: URL? { URL(string: "http://\(host.trimmingCharacters(in: .whitespaces)):\(port)") }
    var wsURL: URL? { URL(string: "ws://\(host.trimmingCharacters(in: .whitespaces)):\(port)/ws") }

    func apply(_ p: PairingPayload) {
        host = p.host
        port = p.port
        key = p.key
    }

    func forget() {
        host = ""
        key = ""
    }
}

// `walkie://pair?host=..&port=..&key=..` (what `walkie pair` prints), or the same fields as JSON.
struct PairingPayload: Equatable {
    var host: String
    var port: Int
    var key: String

    static func parse(_ scanned: String) -> PairingPayload? {
        let text = scanned.trimmingCharacters(in: .whitespacesAndNewlines)
        if let comps = URLComponents(string: text), comps.scheme?.lowercased() == "walkie" {
            let items = comps.queryItems ?? []
            func value(_ n: String) -> String { (items.first { $0.name == n }?.value ?? "").trimmingCharacters(in: .whitespaces) }
            return make(host: value("host"), port: Int(value("port")), key: value("key"))
        }
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let port = (obj["port"] as? Int) ?? Int((obj["port"] as? String) ?? "")
        return make(host: obj["host"] as? String ?? "", port: port, key: obj["key"] as? String ?? "")
    }

    private static func make(host: String, port: Int?, key: String) -> PairingPayload? {
        guard !host.isEmpty, !key.isEmpty else { return nil }
        return PairingPayload(host: host, port: (port ?? 0) > 0 ? port! : 3889, key: key)
    }
}
