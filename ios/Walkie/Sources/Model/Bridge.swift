import Foundation
import Observation

// The phone's side of the Mac bridge: REST for reads and actions, one WebSocket for live frames.
// Holds the session state every screen renders from, so a frame that lands while you're on the
// project list is already there when you open the session.
@MainActor
@Observable
final class Bridge {
    enum State: Equatable { case offline, connecting, online }

    private(set) var state: State = .offline
    private(set) var lastError: String?
    private(set) var liveSessions: [String: SessionSummary] = [:]
    private(set) var events: [String: [AgentEvent]] = [:]
    private(set) var drafts: [String: String] = [:]
    /// Bumped whenever the Mac says a session list changed (started, stopped, renamed, archived anywhere),
    /// so lists on screen reload without a pull.
    private(set) var listVersion = 0
    /// Messages on their way to the Mac (Outbox.swift).
    private(set) var outbox: [Outgoing] = [] { didSet { outboxStore.save(outbox) } }
    /// Set when this phone build and the Mac's bridge can't talk: says which one to update.
    private(set) var incompatible: String?
    /// The Mac's bridge can send push (it has an APNs key). Only then does the app ask for permission.
    private(set) var pushAvailable = false
    /// Session key → the first event that arrived while you were away, for a quiet divider.
    var awayMarker: [String: String] = [:]
    /// Wire range this build speaks (research/fundamentals/protocol-versioning.md).
    static let protocolRange = (min: 1, max: 1)
    // Set when a notification is tapped; HomeView navigates to it and clears it.
    var pendingOpen: SessionRoute?
    @ObservationIgnored private var foreground = true
    @ObservationIgnored private var deviceToken: String?

    @ObservationIgnored let connection: Connection
    @ObservationIgnored private var socket: URLSessionWebSocketTask?
    @ObservationIgnored private var retry = 0
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var watched: Set<String> = []
    @ObservationIgnored private let outboxStore = OutboxStore()
    @ObservationIgnored private var flushing = false
    /// Session key → where the phone's copy of its live log ends.
    @ObservationIgnored private var cursors: [String: (seq: Int, epoch: String)] = [:]
    /// Liveness: a socket can look open long after the network under it died (Wi-Fi to cellular, the
    /// app suspended). The phone pings; no pong in time means a fresh connection.
    @ObservationIgnored private var pingTask: Task<Void, Never>?
    @ObservationIgnored private var lastPong = Date.distantPast
    @ObservationIgnored private let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 20
        c.waitsForConnectivity = false
        return URLSession(configuration: c)
    }()

    init(connection: Connection) {
        self.connection = connection
        self.outbox = outboxStore.load()
    }

    /// A listed session with its live status laid over it.
    func current(_ s: SessionSummary) -> SessionSummary {
        guard var live = liveSessions[s.key] else { return s }
        live.title = (live.title ?? "").isEmpty ? s.title : live.title
        live.cwd = live.cwd ?? s.cwd
        return live
    }

    var waitingCount: Int { liveSessions.values.filter(\.isWaiting).count }

    // MARK: Live connection

    func connect() {
        guard connection.isConfigured, let url = connection.wsURL else { state = .offline; return }
        generation += 1
        if connection.isDemo { socket?.cancel(with: .goingAway, reason: nil); socket = nil; state = .online; lastError = nil; listVersion += 1; return }
        let gen = generation
        socket?.cancel(with: .goingAway, reason: nil)
        var req = URLRequest(url: url)
        req.setValue(connection.key, forHTTPHeaderField: "x-api-key")
        let task = session.webSocketTask(with: req)
        socket = task
        state = .connecting
        task.resume()
        receive(task, gen)
    }

    func disconnect() {
        generation += 1
        pingTask?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        state = .offline
    }

    func foregrounded() {
        foreground = true
        if state != .online { retry = 0; connect() } else { sendPresence(); checkAlive(within: 4) }
        flushOutbox()
    }

    // Tell the bridge whether you're looking at the app, so it only pushes when you're not.
    func backgrounded() {
        foreground = false
        sendPresence()
    }

    private func sendPresence() {
        let msg = #"{"type":"presence","foreground":\#(foreground)}"#
        socket?.send(.string(msg)) { _ in }
    }

    func registerDevice(_ token: String) async {
        deviceToken = token
        struct R: Decodable { let ok: Bool? }
        #if DEBUG
        let env = "sandbox"
        #else
        let env = "production"
        #endif
        let _: R? = try? await request("api/devices", body: ["token": token, "env": env])
    }

    private func receive(_ task: URLSessionWebSocketTask, _ gen: Int) {
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self, gen == self.generation else { return }
                switch result {
                case .success(let message):
                    if self.state != .online { self.didComeOnline() }
                    if case .string(let s) = message, let data = s.data(using: .utf8),
                       let frame = try? JSONDecoder().decode(Frame.self, from: data) {
                        self.handle(frame)
                    }
                    self.receive(task, gen)
                case .failure(let err):
                    self.state = .offline
                    self.lastError = err.localizedDescription
                    self.pingTask?.cancel()
                    self.scheduleReconnect(gen)
                }
            }
        }
    }

    private func didComeOnline() {
        state = .online
        lastError = nil
        retry = 0
        lastPong = .now
        sendPresence()
        startPinging(generation)
        listVersion += 1 // anything that changed while we were away shows without a pull
        Task { await checkPush() }
        if let deviceToken { Task { await registerDevice(deviceToken) } }
        // Catch up on anything on screen from where its log left off, then send what's waiting.
        for key in watched { Task { try? await loadSession(key, markAway: true) } }
        flushOutbox()
    }

    private func startPinging(_ gen: Int) {
        pingTask?.cancel()
        pingTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(20))
                guard let self, gen == self.generation, self.state == .online else { return }
                self.checkAlive(within: 8)
            }
        }
    }

    /// Ping now; if nothing comes back within `seconds`, drop this socket and reconnect.
    private func checkAlive(within seconds: Double) {
        let gen = generation
        let sent = Date.now
        socket?.send(.string(#"{"type":"ping"}"#)) { _ in }
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard let self, gen == self.generation, self.state == .online, self.lastPong < sent else { return }
            self.lastError = "Your Mac stopped answering"
            self.state = .offline
            self.retry = 0
            self.connect()
        }
    }

    private func scheduleReconnect(_ gen: Int) {
        retry += 1
        let delay = min(pow(2.0, Double(min(retry, 5))), 30)
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(delay))
            if gen == self.generation, self.state == .offline { self.connect() }
        }
    }

    func handle(_ frame: Frame) {
        lastPong = .now // any frame proves the socket is alive
        switch frame.type {
        case "hello":
            liveSessions = Dictionary(uniqueKeysWithValues: (frame.sessions ?? []).map { ($0.key, $0) })
        case "event":
            guard let key = frame.key, let ev = frame.event else { return }
            upsert(ev, in: key)
            advance(key, ev)
            if ev.kind == "text" { drafts[key] = nil }
        case "draft":
            if let key = frame.key { drafts[key] = frame.text }
        case "status", "session":
            if let s = frame.session {
                liveSessions[s.key] = s
                if let e = s.epoch, let c = cursors[s.key], c.epoch != e { cursors[s.key] = nil }
            }
        case "closed":
            if let key = frame.key { liveSessions[key] = nil }
        case "sessions", "customize":
            listVersion += 1
        default: break
        }
    }

    private func upsert(_ ev: AgentEvent, in key: String) {
        var list = events[key] ?? []
        if let i = list.lastIndex(where: { $0.id == ev.id }) { list[i] = ev } else { list.append(ev) }
        events[key] = list
    }

    func watch(_ key: String) { watched.insert(key) }
    func unwatch(_ key: String) { watched.remove(key) }

    // MARK: REST

    private func request<T: Decodable>(_ path: String, query: [String: String] = [:], body: [String: Any]? = nil, timeout: TimeInterval = 20) async throws -> T {
        if connection.isDemo { return try JSONDecoder().decode(T.self, from: try Demo.respond(path, query: query, body: body)) }
        guard let base = connection.httpBase, var comps = URLComponents(url: base.appendingPathComponent(path), resolvingAgainstBaseURL: false) else {
            throw BridgeError.notConfigured
        }
        if !query.isEmpty { comps.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) } }
        var req = URLRequest(url: comps.url!)
        req.timeoutInterval = timeout
        req.setValue(connection.key, forHTTPHeaderField: "x-api-key")
        req.setValue(Agent.allCases.map(\.rawValue).joined(separator: ","), forHTTPHeaderField: "x-walkie-agents")
        req.setValue("\(Self.protocolRange.min)-\(Self.protocolRange.max)", forHTTPHeaderField: "x-walkie-protocol")
        if let body {
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: req)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        if code != 426, incompatible != nil { incompatible = nil }
        guard (200..<300).contains(code) else {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            if code == 426 { incompatible = msg ?? "This phone build and your Mac's bridge need updating to match." }
            throw BridgeError.http(code, msg ?? "HTTP \(code)")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    func get<T: Decodable>(_ path: String, query: [String: String] = [:]) async throws -> T { try await request(path, query: query) }
    func post<T: Decodable>(_ path: String, body: [String: Any]) async throws -> T { try await request(path, body: body) }

    func models(fresh: Bool = false) async throws -> [ModelOption] {
        struct R: Decodable { let models: [ModelOption] }
        let r: R = try await request("api/models", query: fresh ? ["fresh": "1"] : [:])
        return r.models
    }

    func projects() async throws -> [Project] {
        struct R: Decodable { let projects: [Project] }
        let r: R = try await request("api/projects")
        return r.projects
    }

    func sessions(cwd: String? = nil) async throws -> [SessionSummary] {
        struct R: Decodable { let sessions: [SessionSummary] }
        let r: R = try await request("api/sessions", query: cwd.map { ["cwd": $0] } ?? [:])
        return r.sessions
    }

    /// Conversations whose title or text matches, open or archived.
    func search(_ q: String) async throws -> [SessionSummary] {
        struct R: Decodable { let results: [SessionSummary] }
        let r: R = try await request("api/search", query: ["q": q])
        return r.results
    }

    /// Everything archived: in Claude or Codex's own record, or Walkie-only.
    func archivedSessions() async throws -> [SessionSummary] {
        struct R: Decodable { let sessions: [SessionSummary] }
        let r: R = try await request("api/sessions", query: ["archived": "1"])
        return r.sessions
    }

    /// Renames in the agent's own record when it has one (Claude), so the terminal and desktop see it too.
    func rename(_ key: String, to title: String, cwd: String?) async throws {
        struct R: Decodable { let ok: Bool }
        var body: [String: Any] = ["key": key, "title": title]
        if let cwd { body["cwd"] = cwd }
        let _: R = try await post("api/session/rename", body: body)
    }

    func archive(_ key: String, _ on: Bool = true, cwd: String?) async throws {
        struct R: Decodable { let ok: Bool }
        var body: [String: Any] = ["key": key, "archived": on]
        if let cwd { body["cwd"] = cwd }
        let _: R = try await post("api/session/archive", body: body)
    }

    /// Loads a session, or catches up from where the phone's copy left off when it's the same live log.
    @discardableResult
    func loadSession(_ key: String, cwd: String? = nil, markAway: Bool = false) async throws -> SessionSummary {
        var q = ["key": key]
        if let cwd { q["cwd"] = cwd }
        if let c = cursors[key], events[key] != nil { q["since"] = String(c.seq); q["epoch"] = c.epoch }
        let r: SessionDetail = try await request("api/session", query: q)
        if r.partial == true {
            if markAway, let first = r.events.first(where: { $0.kind != "resolved" }), awayMarker[key] == nil { awayMarker[key] = first.id }
            for ev in r.events { upsert(ev, in: key) }
        } else {
            events[key] = r.events
        }
        drafts[key] = (r.draft ?? "").isEmpty ? nil : r.draft
        if r.session.live == true, let epoch = r.session.epoch {
            liveSessions[key] = r.session
            cursors[key] = (r.session.seq ?? r.events.compactMap(\.seq).max() ?? 0, epoch)
        } else {
            cursors[key] = nil
        }
        settleOutbox(key)
        return r.session
    }

    private func advance(_ key: String, _ ev: AgentEvent) {
        if let seq = ev.seq, let c = cursors[key], seq > c.seq { cursors[key] = (seq, c.epoch) }
        if ev.kind == "user", ev.clientId != nil { settleOutbox(key) }
    }

    // MARK: Where you left off (for the "new messages" marker when you reopen a conversation)

    @ObservationIgnored private var lastSeen: [String: String] = UserDefaults.standard.dictionary(forKey: "lastSeen") as? [String: String] ?? [:]

    /// Remember the latest message you've seen in a conversation.
    func markSeen(_ key: String) {
        guard let last = events[key]?.last(where: { $0.kind != "resolved" })?.id, lastSeen[key] != last else { return }
        lastSeen[key] = last
        UserDefaults.standard.set(lastSeen, forKey: "lastSeen")
    }

    /// If anything arrived since you last looked, mark where it starts.
    func markUnseen(_ key: String) {
        guard awayMarker[key] == nil, let last = lastSeen[key], let evs = events[key],
              let i = evs.firstIndex(where: { $0.id == last }), i < evs.count - 1,
              let next = evs[(i + 1)...].first(where: { $0.kind != "resolved" && $0.kind != "result" }) else { return }
        awayMarker[key] = next.id
    }

    // MARK: Compose drafts (unsent text per conversation, kept across launches)

    @ObservationIgnored private var composeDrafts: [String: String] = UserDefaults.standard.dictionary(forKey: "composeDrafts") as? [String: String] ?? [:]
    func composeDraft(for key: String) -> String { composeDrafts[key] ?? "" }
    func setComposeDraft(_ text: String, for key: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : text
        guard composeDrafts[key] != t else { return }
        composeDrafts[key] = t
        UserDefaults.standard.set(composeDrafts, forKey: "composeDrafts")
    }

    // MARK: Outbox

    func pending(for key: String) -> [Outgoing] { outbox.filter { $0.key == key } }

    /// Queue a message for a session; it goes now if the Mac is reachable, or as soon as it is.
    func enqueue(_ key: String, cwd: String?, text: String, model: String?) {
        outbox.append(Outgoing(id: UUID().uuidString, key: key, cwd: cwd, text: text, model: model, createdAt: .now))
        flushOutbox()
    }

    func retry(_ id: String) {
        guard let i = outbox.firstIndex(where: { $0.id == id }) else { return }
        outbox[i].state = .waiting; outbox[i].error = nil
        flushOutbox()
    }

    func discard(_ id: String) { outbox.removeAll { $0.id == id } }

    /// Sends waiting messages in order, one session at a time. A message that failed holds the ones
    /// behind it in the same session, so nothing arrives out of order.
    func flushOutbox() {
        guard !flushing else { return }
        flushing = true
        Task { @MainActor in
            defer { flushing = false }
            var blocked = Set<String>()
            while let i = outbox.firstIndex(where: { $0.state == .waiting && !blocked.contains($0.key) }) {
                let item = outbox[i]
                if outbox.contains(where: { $0.key == item.key && $0.createdAt < item.createdAt && ($0.state == .failed || $0.state == .sending) }) { blocked.insert(item.key); continue }
                outbox[i].state = .sending
                do {
                    try await send(item.key, cwd: item.cwd, text: item.text, model: item.model, clientId: item.id)
                    mark(item.id) { $0.state = .sent; $0.sentAt = .now }
                    settleOutbox(item.key)
                } catch let e as URLError {
                    _ = e
                    mark(item.id) { $0.state = .waiting }
                    return // the Mac isn't reachable; didComeOnline tries again
                } catch {
                    mark(item.id) { $0.state = .failed; $0.error = error.localizedDescription }
                    blocked.insert(item.key)
                }
            }
        }
    }

    private func mark(_ id: String, _ change: (inout Outgoing) -> Void) {
        if let i = outbox.firstIndex(where: { $0.id == id }) { change(&outbox[i]) }
    }

    /// Clears sent messages once the transcript shows them (matched by clientId), or a little after
    /// the Mac accepted them if the agent never echoes one.
    private func settleOutbox(_ key: String) {
        let seen = Set((events[key] ?? []).compactMap(\.clientId))
        let before = outbox.count
        let now = Date.now
        let kept = outbox.filter { item in
            guard item.key == key, item.state == .sent else { return true }
            return !seen.contains(item.id) && now.timeIntervalSince(item.sentAt ?? now) < 20
        }
        if kept.count != before { outbox = kept }
    }

    /// Start a conversation. `continueFrom` (a session key) opens it with that conversation, on any agent.
    func start(agent: Agent, cwd: String, text: String, mode: SessionMode, model: String?, effort: String? = nil, continueFrom: String? = nil, clientId: String = UUID().uuidString) async throws -> SessionSummary {
        struct R: Decodable { let session: SessionSummary }
        var body: [String: Any] = ["agent": agent.rawValue, "cwd": cwd, "text": text, "clientId": clientId]
        if let effort { body["effort"] = effort }
        if let continueFrom { body["continueFrom"] = continueFrom }
        if let m = mode.wire { body["mode"] = m }
        if let model, !model.isEmpty { body["model"] = model }
        // Starting can take a while (a CLI booting); a retry with the same clientId gets this same session.
        let r: R = try await request("api/session", body: body, timeout: 90)
        liveSessions[r.session.key] = r.session
        return r.session
    }

    func send(_ key: String, cwd: String?, text: String, model: String? = nil, clientId: String = UUID().uuidString) async throws {
        struct R: Decodable { let session: SessionSummary? }
        if connection.isDemo { demoSend(key, text: text, clientId: clientId); return }
        var body: [String: Any] = ["key": key, "text": text, "clientId": clientId]
        if let model { body["model"] = model }
        if let cwd { body["cwd"] = cwd }
        let r: R = try await request("api/session/send", body: body)
        if let s = r.session { liveSessions[s.key] = s }
    }

    /// The demo answers by itself: your message, a step, a reply.
    private func demoSend(_ key: String, text: String, clientId: String) {
        let now = Date.now.timeIntervalSince1970 * 1000
        upsert(AgentEvent(id: UUID().uuidString, kind: "user", ts: now, text: text, clientId: clientId), in: key)
        var s = liveSessions[key] ?? SessionSummary(key: key, agent: Agent(rawValue: String(key.prefix { $0 != ":" })) ?? .claude, id: String(key.drop { $0 != ":" }.dropFirst()))
        s.status = "running"; s.live = true; s.pending = 0
        liveSessions[key] = s
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.2))
            for (i, ev) in Demo.reply(to: text).enumerated() {
                try? await Task.sleep(for: .seconds(i == 0 ? 0 : 0.9))
                upsert(ev, in: key)
            }
            var done = liveSessions[key]; done?.status = "idle"; liveSessions[key] = done
        }
    }

    func answer(_ key: String, askId: String, choice: String? = nil, answers: [String: String]? = nil, message: String? = nil) async throws {
        struct R: Decodable { let ok: Bool? }
        if connection.isDemo {
            let now = Date.now.timeIntervalSince1970 * 1000
            upsert(AgentEvent(id: "\(askId):r", kind: "resolved", ts: now, choice: choice ?? "answered", ask: askId), in: key)
            upsert(AgentEvent(id: UUID().uuidString, kind: "text", ts: now, text: choice == "deny" ? "Okay, I won't run it. The fix is in place; run the tests whenever you like." : "Tests pass on iPad Pro and iPhone. The login button works on both now."), in: key)
            upsert(AgentEvent(id: UUID().uuidString, kind: "result", ts: now, ok: true, durationMs: 61_000), in: key)
            var s = liveSessions[key]; s?.status = "idle"; s?.pending = 0; liveSessions[key] = s
            return
        }
        var body: [String: Any] = ["key": key, "askId": askId]
        if let choice { body["choice"] = choice }
        if let answers { body["answers"] = answers }
        if let message { body["message"] = message }
        let _: R = try await request("api/session/answer", body: body)
    }

    func setEffort(_ key: String, cwd: String?, effort: String) async throws {
        struct R: Decodable { let session: SessionSummary? }
        var body: [String: Any] = ["key": key, "effort": effort]
        if let cwd { body["cwd"] = cwd }
        let r: R = try await request("api/session/effort", body: body)
        if let s = r.session { liveSessions[s.key] = s }
    }

    /// Ask this conversation's agent to split it into one brief per project. The plan comes back as its reply.
    func plan(_ key: String, cwd: String?) async throws {
        struct R: Decodable { let session: SessionSummary? }
        var body: [String: Any] = ["key": key]
        if let cwd { body["cwd"] = cwd }
        let r: R = try await request("api/session/plan", body: body)
        if let s = r.session { liveSessions[s.key] = s }
    }

    /// Start one session per task. A retry with the same clientId gets the first answer and starts nothing.
    func dispatch(from key: String, tasks: [[String: Any]], clientId: String) async throws -> DispatchResult {
        let r: DispatchResult = try await request("api/dispatch", body: ["from": key, "tasks": tasks, "clientId": clientId], timeout: 180)
        for s in r.sessions { liveSessions[s.key] = s }
        return r
    }

    func interrupt(_ key: String) async throws {
        struct R: Decodable { let ok: Bool? }
        let _: R = try await request("api/session/interrupt", body: ["key": key])
    }

    /// Quick asks for a folder (~/.walkie/walkie.json on the Mac).
    func asks(cwd: String?) async -> [QuickAsk] {
        struct R: Decodable { let asks: [QuickAsk] }
        let r: R? = try? await request("api/asks", query: cwd.map { ["cwd": $0] } ?? [:])
        return r?.asks ?? []
    }

    func commands(key: String?, agent: Agent) async -> [SlashCommand] {
        struct R: Decodable { let commands: [SlashCommand] }
        var q = ["agent": agent.rawValue]
        if let key { q["key"] = key }
        let r: R? = try? await request("api/commands", query: q)
        return r?.commands ?? []
    }

    func status() async -> Bool {
        guard let base = connection.httpBase else { return false }
        guard let (_, resp) = try? await session.data(from: base.appendingPathComponent("api/status")) else { return false }
        return (resp as? HTTPURLResponse)?.statusCode == 200
    }

    private func checkPush() async {
        struct S: Decodable { let push: Bool? }
        guard !connection.isDemo, let base = connection.httpBase, let (data, _) = try? await session.data(from: base.appendingPathComponent("api/status")),
              let s = try? JSONDecoder().decode(S.self, from: data) else { return }
        pushAvailable = s.push == true
    }
}

enum BridgeError: LocalizedError {
    case notConfigured
    case http(Int, String)
    var errorDescription: String? {
        switch self {
        case .notConfigured: "Walkie isn't paired with your Mac yet."
        case .http(_, let msg): msg
        }
    }
}
