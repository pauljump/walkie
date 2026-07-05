import Foundation

// The phone's connection to the Walkie broker on the Mac Mini — the same local broker the
// EM conductor's workspace is joined to. Proven contract (docs/local-broker.md, bridge scout
// 2026-06-13): subscribe over GET /ws (x-api-key header), post directives over POST /api/send.
// The broker stamps the Director's posts with its instance name ("Director") on the workspace,
// so the EM recognizes them as directives.

struct BrokerConfig {
    var host: String
    var port: Int
    var apiKey: String        // the br_ client-auth key (NOT the rk_live_ workspace key)
    var postChannel: String   // where the Director speaks — "standup", addressed as "#standup"
    var listenChannels: [String]  // channels the phone watches: #standup (voice) + #work (team room)

    // Walkie is self-host: the broker runs on the USER'S OWN Mac. There is deliberately NO
    // baked-in target — an empty config means "not set up yet", and the Settings tab is where
    // the user enters their own host/port/key. (Live config is sourced from AppSettings; this
    // empty value is only a safe fallback for tests/previews that don't touch settings.)
    static let empty = BrokerConfig(
        host: "",
        port: 3889,
        apiKey: "",
        postChannel: "standup",
        listenChannels: ["standup", "work"]
    )

    var isConfigured: Bool { !host.trimmingCharacters(in: .whitespaces).isEmpty }

    // URL builders are failable-safe: an empty/garbage host yields nil rather than crashing,
    // so an unconfigured app simply can't connect instead of trapping.
    var httpBase: URL? { URL(string: "http://\(host):\(port)") }
    var wsURL: URL? { URL(string: "ws://\(host):\(port)/ws") }
    // The honest health probe the readiness screen GETs. LocalBus serves this unauthenticated
    // (readiness only, no secrets); kept here so all URL building lives in one place.
    var statusURL: URL? { httpBase?.appendingPathComponent("api/status") }
    var address: String { "#\(postChannel)" }
}

// One channel frame as the broker delivers it on /ws.
struct BrokerFrame: Decodable {
    let from: String?
    let body: String?
    let text: String?
    let target: String?
    let kind: String?
    let seq: Int?
    var message: String { body ?? text ?? "" }
    // Which channel this frame belongs to. The broker forwards ALL its channels to every
    // client, so consumers MUST route by this (empty = unstamped → treat as the voice line).
    var channel: String { (target ?? "").replacingOccurrences(of: "#", with: "").lowercased() }
}

@MainActor
final class BrokerClient: NSObject, ObservableObject {
    enum Connection { case connecting, online, offline }
    @Published private(set) var connection: Connection = .offline

    // Mutable so the Settings tab can hotswap the target at runtime (updateConfig). The live
    // app seeds this from AppSettings; init(config:) stays for test/demo injection.
    private(set) var config: BrokerConfig
    // Many consumers can listen (Standup watches #standup, TeamRoom watches #work) over one
    // shared connection. Each handler routes by frame.channel.
    private var handlers: [(BrokerFrame) -> Void] = []
    func addHandler(_ h: @escaping (BrokerFrame) -> Void) { handlers.append(h) }

    // Fired each time a fresh WS connection opens. The broker replays its full channel
    // history to every client on connect, so consumers use this to mark the incoming burst
    // as catch-up (reconcile the feed, but don't re-speak old lines).
    var onConnect: (() -> Void)?

    private var task: URLSessionWebSocketTask?
    private lazy var session = URLSession(configuration: .default)
    private var retry = 0
    private var stopped = false

    // Live app: no arg → pull the user's saved config from AppSettings. Tests/demos inject
    // an explicit config.
    init(config: BrokerConfig? = nil) {
        self.config = config ?? AppSettings.shared.brokerConfig
        super.init()
    }

    // Hotswap the broker target at runtime (Settings → Save). Tear the current connection
    // down, apply the new address, and reconnect so the new target takes effect immediately.
    // No-op-safe when the new config is empty (stays offline until the user fills it in).
    func updateConfig(_ newConfig: BrokerConfig) {
        disconnect()
        config = newConfig
        guard newConfig.isConfigured else { return }
        connect()
    }

    func connect() {
        // Self-host guard: without a user-entered host there's nothing to dial. Stay offline
        // (the Settings tab invites the user to configure) rather than crash on a nil URL.
        guard config.isConfigured, let wsURL = config.wsURL else {
            connection = .offline
            return
        }
        stopped = false
        connection = .connecting
        var req = URLRequest(url: wsURL)
        req.setValue(config.apiKey, forHTTPHeaderField: "x-api-key")
        let t = session.webSocketTask(with: req)
        task = t
        t.resume()
        // The broker forwards its --channels to local WS clients on connect, but send an
        // explicit subscribe too so this client is correct against stricter brokers.
        let chans = config.listenChannels.map { "\"\($0)\"" }.joined(separator: ",")
        t.send(.string("{\"type\":\"subscribe\",\"channels\":[\(chans)]}")) { _ in }
        connection = .online
        retry = 0
        onConnect?()   // a catch-up replay of channel history is about to stream in
        receiveLoop()
    }

    func disconnect() {
        stopped = true
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        connection = .offline
    }

    private func receiveLoop() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure:
                Task { @MainActor in self.scheduleReconnect() }
            case .success(let message):
                if case let .string(text) = message,
                   let data = text.data(using: .utf8),
                   let frame = try? JSONDecoder().decode(BrokerFrame.self, from: data) {
                    Task { @MainActor in self.handlers.forEach { $0(frame) } }
                }
                Task { @MainActor in self.receiveLoop() }
            }
        }
    }

    private func scheduleReconnect() {
        guard !stopped else { return }
        connection = .offline
        retry += 1
        let delay = min(Double(retry) * 1.5, 10)
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            if !self.stopped { self.connect() }
        }
    }

    // The Director speaks: post the directive into #standup. The EM hears it and dispatches.
    func send(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        guard let base = config.httpBase else { return }
        var req = URLRequest(url: base.appendingPathComponent("api/send"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.setValue(config.apiKey, forHTTPHeaderField: "x-api-key")
        req.httpBody = try? JSONSerialization.data(withJSONObject: [
            "from": "Director", "to": config.address, "text": t,
        ])
        session.dataTask(with: req).resume()
    }

    // Lightweight reachability check for the Settings tab — validates a candidate config
    // WITHOUT touching the live connection, so the user can catch typos / bad keys / a Mac
    // that's asleep before committing. A short POST to /api/send with an empty ping; any HTTP
    // response (even 4xx that isn't auth) means the host is reachable, 401/403 means the key
    // is wrong, a transport error means unreachable.
    enum TestResult { case ok, unauthorized, unreachable(String) }

    static func testConnection(_ config: BrokerConfig) async -> TestResult {
        guard config.isConfigured, let base = config.httpBase else {
            return .unreachable("Enter a host first")
        }
        var req = URLRequest(url: base.appendingPathComponent("api/send"))
        req.httpMethod = "POST"
        req.timeoutInterval = 6
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.setValue(config.apiKey, forHTTPHeaderField: "x-api-key")
        // Empty ping — the broker will accept or reject on auth; we only care that it answers.
        req.httpBody = try? JSONSerialization.data(withJSONObject: [
            "from": "Director", "to": config.address, "text": "",
        ])
        do {
            let (_, resp) = try await URLSession(configuration: .default).data(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if code == 401 || code == 403 { return .unauthorized }
            return .ok
        } catch {
            return .unreachable(error.localizedDescription)
        }
    }
}
