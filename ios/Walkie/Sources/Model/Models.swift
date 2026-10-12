import Foundation

// Wire types for the Mac bridge (mac/src/server.mjs). The event vocabulary is documented in
// mac/src/hub.mjs; every field beyond id/kind is optional because each kind uses a subset.

enum Agent: String, Codable, CaseIterable, Identifiable {
    case claude, codex, agy, grok
    var id: String { rawValue }
    /// The harness: the CLI on the Mac that runs the model.
    var name: String {
        switch self {
        case .claude: "Claude Code"
        case .codex: "Codex"
        case .agy: "Antigravity"
        case .grok: "Grok"
        }
    }
    var short: String {
        switch self {
        case .claude: "Claude"
        case .codex: "Codex"
        case .agy: "Antigravity"
        case .grok: "Grok"
        }
    }
    /// The subscription that pays for it, matching the usage strip's ids.
    var plan: String { rawValue }
    /// Claude, Codex and Grok ask you before risky steps; Antigravity can't, so it runs sandboxed.
    var asksPermission: Bool { self != .agy }
}

/// One model you can pick, on one harness. The same model can appear twice (e.g. Claude Opus via
/// Claude Code, and via Antigravity on the Google plan).
struct ModelOption: Codable, Identifiable, Hashable {
    let key: String
    let id: String
    let name: String
    var description: String?
    let harness: Agent
    let family: String
    var isDefault: Bool?
    var efforts: [String]?
    var defaultEffort: String?
    var older: Bool?
    var modelID: String { id }

    /// "claude-sonnet-5[1m]" → "Sonnet 5" when the catalog knows it; else the id as-is.
    static func displayName(_ id: String, harness: Agent, in catalog: [ModelOption]) -> String {
        let bare = id.replacingOccurrences(of: #"\[.*\]$"#, with: "", options: .regularExpression)
        let match = catalog.filter { $0.harness == harness }.first { $0.id == bare || bare.hasPrefix($0.id) || $0.id.hasPrefix(bare) }
        return match?.name ?? bare
    }

}

enum SessionMode: String, CaseIterable, Identifiable {
    case ask, auto, plan
    var id: String { rawValue }
    var label: String {
        switch self {
        case .ask: "Ask before changes"
        case .auto: "Auto-accept edits"
        case .plan: "Plan first"
        }
    }
    func available(for agent: Agent) -> Bool {
        switch agent {
        case .claude: true
        case .agy: self != .plan
        default: self != .plan
        }
    }
    var wire: String? { self == .ask ? nil : rawValue }
}

struct Project: Codable, Identifiable, Hashable {
    let path: String
    let name: String
    let updatedAt: Double?
    var id: String { path }
}

struct SessionSummary: Codable, Identifiable, Hashable {
    let key: String
    let agent: Agent
    let id: String
    var cwd: String?
    var title: String?
    var status: String?
    var live: Bool?
    var updatedAt: Double?
    var pending: Int?
    var branch: String?
    var model: String?
    var effort: String?
    /// Sync state (docs/SYNC.md): open = running somewhere on the Mac, held by Walkie, or touched lately
    /// and not seen to stop. remote = Remote Control is on for it right now.
    var open: Bool?
    var running: Bool?
    var remote: Bool?
    /// Live log position and identity: a new epoch means the Mac rebuilt the log, so seqs start over.
    var seq: Int?
    var epoch: String?
    var archived: Bool?
    var voice: Bool?
    /// Search results: "title" or "text" (where the match was).
    var match: String?

    var isWaiting: Bool { status == "waiting" || (pending ?? 0) > 0 }
    var isRunning: Bool { status == "running" }
    var displayTitle: String {
        let t = (title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? "Untitled session" : t
    }
    var updated: Date { Date(timeIntervalSince1970: (updatedAt ?? 0) / 1000) }
}

struct AskOption: Codable, Hashable {
    let id: String
    let label: String
    var style: String?
}

struct QuestionOption: Codable, Hashable {
    let label: String
    var description: String?
}

struct AskQuestion: Codable, Hashable {
    var id: String?
    let question: String
    var header: String?
    var options: [QuestionOption]?
    var multiSelect: Bool?
}

struct AgentEvent: Codable, Identifiable, Hashable {
    let id: String
    let kind: String
    var ts: Double?
    var text: String?
    var tool: String?
    var title: String?
    var detail: String?
    var diff: String?
    var output: String?
    var status: String?
    var type: String?
    var options: [AskOption]?
    var questions: [AskQuestion]?
    var choice: String?
    var ask: String?
    var ok: Bool?
    var costUsd: Double?
    var durationMs: Double?
    /// Position in the session's live log on the Mac; catch-up asks for everything after the last one seen.
    var seq: Int?
    /// On a `user` event: the id the phone gave the message, so the outbox knows it arrived.
    var clientId: String?
    /// Said out loud (a voice chat's transcript) rather than typed.
    var voice: Bool?
    /// On an `info` event: a session key it points to ("Continued in Codex").
    var link: String?
}

struct SlashCommand: Codable, Hashable, Identifiable {
    let name: String
    var description: String?
    var prefix: String?
    var id: String { name }
    var insertion: String { "\(prefix ?? "/")\(name) " }
}

// Frames pushed over /ws.
struct Frame: Decodable {
    let type: String
    var key: String?
    var event: AgentEvent?
    var text: String?
    var status: String?
    var session: SessionSummary?
    var sessions: [SessionSummary]?
}

struct SessionDetail: Decodable {
    let session: SessionSummary
    let events: [AgentEvent]
    let draft: String?
    /// True when `events` holds only what changed after the seq the phone asked from.
    var partial: Bool?
}


extension Date {
    /// Chat-list time: "now", "5m", "2h", "3d", then "Sep 12".
    var short: String {
        let s = -timeIntervalSinceNow
        if s < 60 { return "now" }
        if s < 3600 { return "\(Int(s / 60))m" }
        if s < 86_400 { return "\(Int(s / 3600))h" }
        if s < 7 * 86_400 { return "\(Int(s / 86_400))d" }
        return formatted(.dateTime.month(.abbreviated).day())
    }
}

/// Text Walkie itself sends to agents. A conversation continued from another subscription opens with
/// the old transcript (mac/src/handoff.mjs); the timeline shows that as one quiet note and only what
/// you typed as your bubble.
enum WalkiePrompt {
    static let messageMark = "\n\n[My message]\n"

    static let planMark = "[Walkie: send to projects]"

    static func split(_ text: String) -> (note: String?, yours: String?) {
        if text.hasPrefix(planMark) { return ("Asked to split this into one session per project", nil) }
        guard text.hasPrefix("[Continued from "), let mark = text.range(of: messageMark) else { return (nil, text) }
        let head = text[..<(text.firstIndex(of: "]") ?? text.startIndex)].dropFirst()
        return (String(head), String(text[mark.upperBound...]))
    }
}

/// "Send to projects": the agent's reply to the plan turn (mac/src/handoff.mjs), one brief per project.
struct ProjectPlan: Decodable, Hashable {
    struct Task: Decodable, Hashable {
        let project: String
        var title: String?
        let brief: String
    }
    let tasks: [Task]

    /// The plan in an agent reply: a ```json block, or the whole reply, holding {"tasks":[…]}.
    static func from(_ text: String) -> ProjectPlan? {
        guard text.contains("\"tasks\""), let open = text.firstIndex(of: "{"), let close = text.lastIndex(of: "}"), open < close else { return nil }
        return try? JSONDecoder().decode(ProjectPlan.self, from: Data(text[open...close].utf8))
    }
}

struct DispatchResult: Decodable {
    struct Failure: Decodable, Hashable { let cwd: String?; let error: String }
    let sessions: [SessionSummary]
    let failed: [Failure]
}

/// A quick ask (~/.walkie/walkie.json on the Mac): a button that sends `text`.
struct QuickAsk: Decodable, Hashable, Identifiable {
    let title: String
    let text: String
    var id: String { title + text }
}
