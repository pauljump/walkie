import SwiftUI
import Combine

// Live state, backed by the Walkie broker on the Mac Mini. The Director speaks (TalkBar →
// addDirectorReply → broker.send); the EM "Mara" answers on #standup and those lines land
// here. The feed holds ONLY real signal (product law #1): only the EM reaches the Director,
// so worker chatter and our own echoes are filtered out. Ambient "who's building" lives on
// the agent strip, never as feed chatter.
@MainActor
final class Standup: ObservableObject {
    @Published var agents: [Agent]
    @Published var feed: [StandupItem]
    @Published var statusLine: String = "connecting…"

    private let broker: BrokerClient
    private var cancellables = Set<AnyCancellable>()
    private static let seed = "Connecting to the room…"

    // Replay guard. The broker dumps its full channel history on every (re)connect. We keep a
    // high-water mark of the last sequence number actually shown, and — for brokers that don't
    // stamp a seq — a short "catch-up" window after each connect during which Mara's lines are
    // reconciled into the feed silently, never re-spoken. Without this, backgrounding the app
    // makes Mara read the whole conversation back from the top on the way in.
    private var lastSeenSeq = -1
    private var catchingUp = false
    private var catchupTimer: Timer?

    // Fired when a new EM (Mara) line lands — the voice session speaks it aloud.
    var onEMReply: ((String) -> Void)?

    init(broker: BrokerClient) {
        self.broker = broker
        agents = [Agent(name: "Mara", role: .em, status: .idle)]
        feed = [StandupItem(speaker: "Mara", kind: .emSummary, text: Self.seed)]

        broker.addHandler { [weak self] frame in self?.handle(frame) }
        broker.onConnect = { [weak self] in self?.beginCatchup() }
        broker.$connection
            .receive(on: RunLoop.main)
            .sink { [weak self] c in
                switch c {
                case .online:     self?.statusLine = "live"
                case .connecting: self?.statusLine = "connecting…"
                case .offline:    self?.statusLine = "offline"
                }
            }
            .store(in: &cancellables)
    }

    // Route an incoming #standup frame. Only the EM's curated voice surfaces to the Director.
    private func handle(_ frame: BrokerFrame) {
        // Stay on the voice line. The broker forwards #work too (Mara hands off to engineers
        // there AS herself) — those must never reach the standup feed or get spoken aloud.
        let ch = frame.channel
        guard ch.isEmpty || ch == "standup" else { return }
        guard (frame.from ?? "") == "Mara" else { return }   // ignore echoes + worker chatter
        let text = frame.message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        // Replay dedup: when the broker stamps a seq, a frame at or below the high-water mark
        // is history we've already shown — drop it outright (no duplicate row, no re-speak).
        if let seq = frame.seq {
            guard seq > lastSeenSeq else { return }
            lastSeenSeq = seq
        }
        // During the catch-up burst after a (re)connect, keep extending the quiet window so the
        // whole backlog reconciles without being read aloud.
        if catchingUp { armCatchupEnd() }

        feed.removeAll { $0.kind == .emSummary && $0.text == Self.seed }

        let kind: ItemKind
        if text.hasPrefix("✅") { kind = .shipped }
        else if text.hasPrefix("⚠️") || text.lowercased().contains("blocked") { kind = .decision }
        else { kind = .emSummary }
        feed.append(StandupItem(speaker: "Mara", kind: kind, text: text))
        agents[0].status = kind == .shipped ? .shipped : (kind == .decision ? .blocked : .building)
        if !catchingUp { onEMReply?(text) }   // speak live lines only, never replayed history
    }

    // A fresh WS connection opened — the broker is about to replay channel history. Go silent
    // until the burst settles (re-armed per frame in handle); then resume speaking live lines.
    private func beginCatchup() {
        catchingUp = true
        armCatchupEnd()
    }

    private func armCatchupEnd() {
        catchupTimer?.invalidate()
        catchupTimer = Timer.scheduledTimer(withTimeInterval: 0.8, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.catchingUp = false }
        }
    }

    // The Director speaks: show it locally and send it to the EM.
    func addDirectorReply(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        feed.append(StandupItem(speaker: "You", kind: .director, text: t))
        broker.send(t)
    }

    func answerDecision(_ item: StandupItem, _ choice: String) {
        let reply = "\(choice). Go."
        feed.append(StandupItem(speaker: "You", kind: .director, text: reply))
        broker.send(reply)
        feed.removeAll { $0.id == item.id }
    }
}
