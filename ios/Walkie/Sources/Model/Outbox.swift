import Foundation

/// A message you sent to a session, until the Mac confirms the agent has it.
/// Its id is the clientId: made once when you hit send and reused on every retry, so the bridge
/// runs it exactly once however many times the phone tries (research/fundamentals/delivery-and-reconnect.md).
struct Outgoing: Codable, Identifiable, Hashable {
    enum State: String, Codable { case waiting, sending, sent, failed }

    let id: String
    let key: String
    let cwd: String?
    let text: String
    let model: String?
    let createdAt: Date
    var state: State = .waiting
    var error: String?
    var sentAt: Date?
}

/// Messages waiting for the Mac, kept on disk so a killed app still sends them. The phone only shows
/// what's here; the Mac's echo of the same clientId in the transcript is what clears a row.
struct OutboxStore {
    private let url: URL = {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("outbox.json")
    }()

    func load() -> [Outgoing] {
        guard let data = try? Data(contentsOf: url), var items = try? JSONDecoder().decode([Outgoing].self, from: data) else { return [] }
        // Anything caught mid-send when the app died goes back to waiting; the clientId makes that safe.
        for i in items.indices where items[i].state == .sending { items[i].state = .waiting }
        return items
    }

    func save(_ items: [Outgoing]) {
        if let data = try? JSONEncoder().encode(items) { try? data.write(to: url, options: .atomic) }
    }
}
