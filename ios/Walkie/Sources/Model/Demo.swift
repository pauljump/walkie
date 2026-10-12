import Foundation

// The built-in demo: Walkie with no Mac. App Review has no Mac to pair with, and a first-time
// visitor wants to see it before installing a bridge. Pairing with host "demo" makes Bridge answer
// every request from here. Nothing leaves the phone.
enum Demo {
    static let host = "demo"
    static let root = "/Users/you/projects"
    private static let now = Date.now.timeIntervalSince1970 * 1000

    static func respond(_ path: String, query: [String: String], body: [String: Any]?) throws -> Data {
        let json: Any
        switch path {
        case "api/projects": json = ["projects": projects]
        case "api/sessions": json = ["sessions": query["archived"] == "1" ? [] : sessions]
        case "api/search":
            let q = (query["q"] ?? "").lowercased()
            json = ["results": sessions.filter { (($0["title"] as? String) ?? "").lowercased().contains(q) }.map { var s = $0; s["match"] = "title"; return s }]
        case "api/session":
            let key = query["key"] ?? ""
            json = ["session": sessions.first { ($0["key"] as? String) == key } ?? ["key": key, "agent": "claude", "id": "x"], "events": events[key] ?? [], "draft": ""]
        case "api/session/send", "api/session/answer", "api/session/interrupt", "api/session/effort", "api/session/rename", "api/session/archive", "api/devices":
            json = ["ok": true]
        case "api/session/plan": json = ["session": sessions[0]]
        case "api/dispatch": json = ["sessions": [], "failed": [["cwd": (body?["tasks"] as? [[String: Any]])?.first?["cwd"] ?? "", "error": "This is the demo. Pair with your Mac to start real sessions."]]]
        case "api/commands": json = ["commands": [["name": "review", "description": "Review the current changes"], ["name": "compact", "description": "Compact the conversation"]]]
        case "api/usage": json = ["providers": usage]
        case "api/models": json = ["models": models]
        case "api/asks": json = ["asks": [["title": "Run the tests", "text": "Run the test suite and fix anything that fails."], ["title": "What changed?", "text": "Summarize what changed in this project this week."]]]
        default: json = ["error": "not in the demo"]
        }
        return try JSONSerialization.data(withJSONObject: json)
    }

    /// What the demo says back when you type: one line, then it shows a tool step and a reply.
    static func reply(to text: String) -> [AgentEvent] {
        [
            AgentEvent(id: UUID().uuidString, kind: "tool", ts: now, tool: "Read", title: "Read ~/projects/app/README.md", status: "ok"),
            AgentEvent(id: UUID().uuidString, kind: "text", ts: now, text: "This is Walkie's demo, so nothing runs. On your own Mac, this is where \(["Claude Code", "Codex"].randomElement()!) would answer “\(text.prefix(60))”, with every tool step and diff in the conversation and a question card whenever it needs you.\n\nPair with your Mac from Settings when you're ready."),
            AgentEvent(id: UUID().uuidString, kind: "result", ts: now, ok: true, durationMs: 4200),
        ]
    }

    static let projects: [[String: Any]] = [
        ["path": "\(root)/app", "name": "app", "updatedAt": now - 60_000],
        ["path": "\(root)/site", "name": "site", "updatedAt": now - 3_600_000],
        ["path": "\(root)/api", "name": "api", "updatedAt": now - 86_400_000],
    ]

    static let sessions: [[String: Any]] = [
        ["key": "claude:d1", "agent": "claude", "id": "d1", "cwd": "\(root)/app", "title": "Fix the login button on iPad", "status": "waiting", "live": true, "pending": 1, "updatedAt": now - 20_000, "model": "claude-opus-5-5", "open": true],
        ["key": "codex:d2", "agent": "codex", "id": "d2", "cwd": "\(root)/site", "title": "Add dark mode to the marketing site", "status": "running", "live": true, "updatedAt": now - 95_000, "model": "gpt-6-codex", "open": true],
        ["key": "claude:d3", "agent": "claude", "id": "d3", "cwd": "\(root)/api", "title": "Why are the nightly jobs slow?", "status": "idle", "live": false, "updatedAt": now - 2_700_000, "open": false],
        ["key": "agy:d4", "agent": "agy", "id": "d4", "cwd": "\(root)/app", "title": "Write release notes for 2.3", "status": "idle", "live": false, "updatedAt": now - 7_200_000, "open": false],
        ["key": "grok:d5", "agent": "grok", "id": "d5", "cwd": "\(root)/api", "title": "Rate limiter for the public endpoints", "status": "idle", "live": false, "updatedAt": now - 90_000_000, "open": false],
        ["key": "codex:d6", "agent": "codex", "id": "d6", "cwd": "\(root)/app", "title": "Monday planning", "status": "idle", "live": false, "updatedAt": now - 180_000_000, "open": false],
    ]

    static let events: [String: [[String: Any]]] = [
        "claude:d1": [
            ["id": "u1", "kind": "user", "ts": now - 400_000, "text": "The login button does nothing on iPad. Can you find out why and fix it?"],
            ["id": "t1", "kind": "tool", "ts": now - 390_000, "tool": "Grep", "title": "Search \"loginButton\"", "detail": "~/projects/app", "status": "ok", "output": "Sources/Auth/LoginView.swift:42\nSources/Auth/LoginView.swift:88"],
            ["id": "t2", "kind": "tool", "ts": now - 380_000, "tool": "Read", "title": "Read ~/projects/app/Sources/Auth/LoginView.swift", "status": "ok"],
            ["id": "m1", "kind": "text", "ts": now - 360_000, "text": "Found it. On iPad the form is inside a `Form` with a `NavigationSplitView`, and the button's action is attached with `.onTapGesture` on a `Label`, which the split view's sidebar gesture swallows. On iPhone there's no sidebar, so it works.\n\nThe fix is to make it a real `Button`. That also gives it the right accessibility traits."],
            ["id": "t3", "kind": "tool", "ts": now - 300_000, "tool": "Edit", "title": "Edit ~/projects/app/Sources/Auth/LoginView.swift", "status": "ok", "diff": "--- ~/projects/app/Sources/Auth/LoginView.swift\n+++ ~/projects/app/Sources/Auth/LoginView.swift\n-Label(\"Log in\", systemImage: \"person\")\n-    .onTapGesture { logIn() }\n+Button { logIn() } label: {\n+    Label(\"Log in\", systemImage: \"person\")\n+}\n+.buttonStyle(.borderedProminent)"],
            ["id": "a1", "kind": "ask", "ts": now - 20_000, "type": "permission", "tool": "Bash", "title": "$ xcodebuild test -scheme App -destination 'platform=iOS Simulator,name=iPad Pro'", "detail": "Run the UI tests on an iPad simulator to confirm the fix", "options": [["id": "allow", "label": "Allow"], ["id": "always", "label": "Always allow"], ["id": "deny", "label": "Deny", "style": "destructive"]]],
        ],
        "codex:d2": [
            ["id": "u1", "kind": "user", "ts": now - 600_000, "text": "Add a dark mode to the marketing site. Respect the system setting and add a toggle in the footer."],
            ["id": "t1", "kind": "tool", "ts": now - 500_000, "tool": "shell", "title": "$ rg -n \"prefers-color-scheme\" src", "status": "ok", "output": "(no matches)"],
            ["id": "t2", "kind": "tool", "ts": now - 400_000, "tool": "edit", "title": "Edit tokens.css, site.js, footer.html", "status": "ok"],
            ["id": "t3", "kind": "tool", "ts": now - 95_000, "tool": "shell", "title": "$ npm run build && npm test", "status": "running"],
        ],
        "claude:d3": [
            ["id": "u1", "kind": "user", "ts": now - 3_000_000, "text": "Why are the nightly jobs slow since Tuesday?"],
            ["id": "m1", "kind": "text", "ts": now - 2_800_000, "text": "Tuesday's deploy added an index on `events(created_at)` but the nightly rollup filters on `account_id, created_at`, so Postgres now picks the new index and scans 40× more rows. Two options:\n\n1. Add a composite index on `(account_id, created_at)`.\n2. Drop Tuesday's index if nothing else needs it.\n\nI'd do 1. Want me to write the migration?"],
            ["id": "r1", "kind": "result", "ts": now - 2_700_000, "ok": true, "durationMs": 48_000],
        ],
        "codex:d6": [
            ["id": "u1", "kind": "user", "ts": now - 190_000_000, "text": "Let's plan the week. App: ship the login fix and start the onboarding redesign. Site: dark mode, then the pricing page. API: the nightly job slowness, and rate limits before we open the public endpoints."],
            ["id": "m1", "kind": "text", "ts": now - 189_000_000, "text": "Got it. Here's how I'd split it:\n\n```json\n{\"tasks\":[{\"project\":\"\(root)/app\",\"title\":\"Login fix, then onboarding redesign\",\"brief\":\"Ship the iPad login fix first (real Button instead of a tap gesture). Then start the onboarding redesign: three screens, skip always visible, done when a new user reaches the home screen in under 30 seconds.\"},{\"project\":\"\(root)/site\",\"title\":\"Dark mode, then pricing\",\"brief\":\"Dark mode that follows the system setting with a footer toggle. Then the pricing page: three tiers, annual toggle, FAQ.\"},{\"project\":\"\(root)/api\",\"title\":\"Nightly jobs and rate limits\",\"brief\":\"Add the composite index on events(account_id, created_at) and confirm the rollup is back under 10 minutes. Then a token-bucket rate limiter on the public endpoints, 60/min per key, 429 with Retry-After.\"}]}\n```"],
            ["id": "r1", "kind": "result", "ts": now - 188_000_000, "ok": true, "durationMs": 31_000],
        ],
    ]

    static let usage: [[String: Any]] = [
        ["id": "claude", "label": "Claude", "plan": "max", "state": "warning", "windows": [["name": "5 hours", "usedPct": 82, "resetsAt": now + 5_400_000], ["name": "Week", "usedPct": 61, "resetsAt": now + 172_800_000]]],
        ["id": "codex", "label": "ChatGPT", "plan": "pro", "state": "ok", "windows": [["name": "5 hours", "usedPct": 12, "resetsAt": now + 9_000_000], ["name": "Week", "usedPct": 34, "resetsAt": now + 300_000_000]]],
        ["id": "agy", "label": "Google", "plan": "Antigravity", "state": "ok", "windows": [["name": "Week · Gemini", "usedPct": 5, "resetsAt": now + 400_000_000]]],
        ["id": "grok", "label": "Grok", "state": "unmetered", "windows": [], "note": "Grok reports usage per session only"],
    ]

    static let models: [[String: Any]] = [
        ["key": "claude/claude-opus-5-5", "id": "claude-opus-5-5", "name": "Opus 5.5", "harness": "claude", "family": "Claude Opus", "isDefault": true, "efforts": ["low", "medium", "high", "xhigh", "max"], "defaultEffort": "high"],
        ["key": "claude/claude-sonnet-5-5", "id": "claude-sonnet-5-5", "name": "Sonnet 5.5", "harness": "claude", "family": "Claude Sonnet", "efforts": ["low", "medium", "high"]],
        ["key": "codex/gpt-6-codex", "id": "gpt-6-codex", "name": "GPT-6 Codex", "harness": "codex", "family": "GPT", "isDefault": true, "efforts": ["low", "medium", "high"]],
        ["key": "agy/gemini-3-pro", "id": "gemini-3-pro", "name": "Gemini 3 Pro", "harness": "agy", "family": "Gemini Pro", "isDefault": true],
        ["key": "grok/grok-5", "id": "grok-5", "name": "Grok 5", "harness": "grok", "family": "Grok", "isDefault": true],
    ]
}
