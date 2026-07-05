import SwiftUI
import Combine

// The team room — a live view of #work, the channel where Mara hands tasks to the
// engineers and they ack/report in their own voice. Watchable, not curated: this is
// the "watch your company work while you walk" surface. The voice line (#standup) stays
// the only thing that reaches the Director's ear; this is eyes-only.
struct RoomLine: Identifiable {
    let id = UUID()
    let speaker: String
    let text: String
    var isEM: Bool { speaker.lowercased() == "mara" }
}

@MainActor
final class TeamRoom: ObservableObject {
    @Published var lines: [RoomLine] = []
    @Published var roster: [Agent]
    @Published var lastSpeaker: String = ""

    private let broker: BrokerClient

    // The persistent team (frozen personas in walkie/team/*.md). Mara conducts; the three build.
    init(broker: BrokerClient) {
        self.broker = broker
        roster = [
            Agent(name: "Mara", role: .em, status: .idle),
            Agent(name: "Theo", role: .engineer, status: .idle),
            Agent(name: "Cora", role: .design, status: .idle),
            Agent(name: "Nia", role: .qa, status: .idle),
        ]
        broker.addHandler { [weak self] frame in self?.handle(frame) }
    }

    private func handle(_ frame: BrokerFrame) {
        guard frame.channel == "work" else { return }          // team room only
        let from = (frame.from ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let text = frame.message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !from.isEmpty, !text.isEmpty else { return }

        lines.append(RoomLine(speaker: from, text: text))
        if lines.count > 200 { lines.removeFirst(lines.count - 200) }  // bound the scrollback
        lastSpeaker = from

        // Reflect reality on the strip: an engineer is "building" from their ack until they
        // report. A finished/blocked line settles them to shipped/blocked — never stuck on
        // "building" (that read like a runaway). Only the speaker changes; Mara (EM) doesn't.
        let lower = text.lowercased()
        let isDone = ["pr ", "pr:", "pull request", " done", "shipped", "verified", "✅", "opened"].contains { lower.contains($0) }
        let isBlocked = ["blocked", "snag", "can't", "cannot", "couldn't", "stuck", "failed", "⚠️"].contains { lower.contains($0) }
        if let i = roster.firstIndex(where: { $0.name.lowercased() == from.lowercased() }), roster[i].role != .em {
            roster[i].status = isBlocked ? .blocked : (isDone ? .shipped : .building)
        }
    }
}
