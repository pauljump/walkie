import XCTest
@testable import Walkie

final class WireTests: XCTestCase {
    func testPairingLink() {
        let p = PairingPayload.parse("walkie://pair?host=mac.tail.ts.net&port=3889&key=abc")
        XCTAssertEqual(p, PairingPayload(host: "mac.tail.ts.net", port: 3889, key: "abc"))
        XCTAssertEqual(PairingPayload.parse(#"{"host":"h","key":"k"}"#)?.port, 3889)
        XCTAssertNil(PairingPayload.parse("walkie://pair?host=h"), "a link without a key can't pair")
        XCTAssertNil(PairingPayload.parse("https://example.com"))
    }

    func testFrameDecoding() throws {
        let json = #"{"type":"event","key":"claude:1","event":{"id":"a","kind":"ask","type":"permission","title":"$ ls","options":[{"id":"allow","label":"Allow"}],"ts":1}}"#
        let f = try JSONDecoder().decode(Frame.self, from: Data(json.utf8))
        XCTAssertEqual(f.event?.options?.first?.id, "allow")
        let q = #"{"id":"q","kind":"ask","type":"question","questions":[{"question":"Which?","header":"Pick","options":[{"label":"A","description":"a"}],"multiSelect":false}]}"#
        XCTAssertEqual(try JSONDecoder().decode(AgentEvent.self, from: Data(q.utf8)).questions?.first?.options?.count, 1)
    }

    @MainActor
    func testEventsUpsertById() {
        let bridge = Bridge(connection: Connection(defaults: UserDefaults(suiteName: "walkie-tests")!, secure: MemoryStore()))
        bridge.handle(Frame(type: "event", key: "k", event: AgentEvent(id: "t", kind: "tool", status: "running")))
        bridge.handle(Frame(type: "draft", key: "k", text: "Hel"))
        bridge.handle(Frame(type: "event", key: "k", event: AgentEvent(id: "t", kind: "tool", status: "ok")))
        bridge.handle(Frame(type: "event", key: "k", event: AgentEvent(id: "m", kind: "text", text: "Hello")))
        XCTAssertEqual(bridge.events["k"]?.map(\.status), ["ok", nil])
        XCTAssertNil(bridge.drafts["k"], "final text replaces the streaming draft")
    }

    func testContinuedConversationsReadAsANote() {
        let text = "[Continued from a Claude Code conversation: \"Fix login\"]\n\nWe were working in /p. Here is the conversation so far.\n\nMe: hi\n\nAgent: hello\n\n[My message]\nNow add a test"
        let parts = WalkiePrompt.split(text)
        XCTAssertEqual(parts.note, "Continued from a Claude Code conversation: \"Fix login\"")
        XCTAssertEqual(parts.yours, "Now add a test")
        XCTAssertEqual(WalkiePrompt.split("just me").yours, "just me")
        XCTAssertNil(WalkiePrompt.split("just me").note)
        XCTAssertNil(WalkiePrompt.split("[Continued from nowhere, no mark").note, "without the message mark it's just text")
    }

    func testAgentPlansParseFromTheReply() {
        let reply = "Here's the split:\n\n```json\n{\"tasks\":[{\"project\":\"/p/walkie\",\"title\":\"Grok meter\",\"brief\":\"Add it.\"},{\"project\":\"/p/kit\",\"brief\":\"Doctor brief.\"}]}\n```"
        let plan = ProjectPlan.from(reply)
        XCTAssertEqual(plan?.tasks.map(\.project), ["/p/walkie", "/p/kit"])
        XCTAssertNil(plan?.tasks[1].title, "a title is optional")
        XCTAssertEqual(ProjectPlan.from(#"{"tasks":[]}"#)?.tasks.count, 0)
        XCTAssertNil(ProjectPlan.from("No plan, just words about tasks."))
        XCTAssertNil(ProjectPlan.from(#"{"tasks": "oops"}"#), "a malformed plan is ignored, not half-shown")
        let ask = WalkiePrompt.split("[Walkie: send to projects]\n\nTurn what we agreed…")
        XCTAssertEqual(ask.note, "Asked to split this into one session per project")
        XCTAssertNil(ask.yours)
    }

    func testDemoAnswersEveryScreenTheAppAsksFor() throws {
        for path in ["api/projects", "api/sessions", "api/usage", "api/models", "api/asks", "api/commands"] {
            let data = try Demo.respond(path, query: [:], body: nil)
            XCTAssertNotNil(try JSONSerialization.jsonObject(with: data) as? [String: Any], path)
        }
        struct R: Decodable { let sessions: [SessionSummary] }
        let s = try JSONDecoder().decode(R.self, from: Demo.respond("api/sessions", query: [:], body: nil))
        XCTAssertEqual(Set(s.sessions.map(\.agent)), Set(Agent.allCases), "the demo shows every subscription")
        XCTAssertTrue(s.sessions.contains { $0.isWaiting }, "something needs you, so the ask card shows")
        let d = try JSONDecoder().decode(SessionDetail.self, from: Demo.respond("api/session", query: ["key": "claude:d1"], body: nil))
        XCTAssertTrue(d.events.contains { $0.kind == "ask" })
        let plan = try JSONDecoder().decode(SessionDetail.self, from: Demo.respond("api/session", query: ["key": "codex:d6"], body: nil))
        XCTAssertEqual(ProjectPlan.from(plan.events.first { $0.kind == "text" }?.text ?? "")?.tasks.count, 3, "the planning demo parses as a plan")
    }

    @MainActor
    func testFreeTierIsOneSubscriptionAndFailsOpenUntilTheStoreAnswers() {
        UserDefaults.standard.set(true, forKey: "walkieGate")
        defer { UserDefaults.standard.removeObject(forKey: "walkieGate"); UserDefaults.standard.removeObject(forKey: "wk.store.freeHarness") }
        let store = Store()
        store.freeHarness = nil
        XCTAssertTrue(store.unlocked, "no price ever seen: nothing is gated")
        // Once a price has been seen (simulated through the persisted flag) the gate holds.
        UserDefaults.standard.set(true, forKey: "wk.store.seenPrice")
        defer { UserDefaults.standard.removeObject(forKey: "wk.store.seenPrice") }
        let gated = Store()
        gated.freeHarness = nil
        XCTAssertFalse(gated.unlocked)
        XCTAssertTrue(gated.allows(.claude), "any first CLI is fine")
        gated.claim(.claude)
        XCTAssertTrue(gated.allows(.claude))
        XCTAssertFalse(gated.allows(.codex), "a second CLI asks you to buy")
        gated.claim(.codex)
        XCTAssertEqual(gated.freeHarness, .claude, "claiming never moves the free one")
    }

    func testInfoEventsCarryALink() throws {
        let json = #"{"id":"i","kind":"info","text":"Continued in Codex","link":"codex:x1"}"#
        XCTAssertEqual(try JSONDecoder().decode(AgentEvent.self, from: Data(json.utf8)).link, "codex:x1")
    }

    @MainActor
    func testAnyFrameCountsAsProofOfLife() {
        let bridge = Bridge(connection: Connection(defaults: UserDefaults(suiteName: "walkie-tests")!, secure: MemoryStore()))
        let before = bridge.listVersion
        bridge.handle(Frame(type: "pong"))
        bridge.handle(Frame(type: "sessions"))
        XCTAssertEqual(bridge.listVersion, before + 1, "a pong is harmless; a sessions frame reloads lists")
    }

    func testWireDecodesSeqAndClientId() throws {
        let json = #"{"session":{"key":"claude:a","agent":"claude","id":"a","live":true,"seq":7,"epoch":"e1"},"events":[{"id":"u","kind":"user","text":"hi","seq":7,"clientId":"c1"}],"draft":"","partial":true}"#
        let d = try JSONDecoder().decode(SessionDetail.self, from: Data(json.utf8))
        XCTAssertEqual(d.partial, true)
        XCTAssertEqual(d.session.epoch, "e1")
        XCTAssertEqual(d.events.first?.clientId, "c1")
        XCTAssertEqual(d.events.first?.seq, 7)
    }

    func testOutboxSurvivesAKilledAppMidSend() {
        let store = OutboxStore()
        let saved = store.load()
        defer { store.save(saved) }
        var item = Outgoing(id: "c1", key: "claude:a", cwd: nil, text: "hi", model: nil, createdAt: .now)
        item.state = .sending
        store.save([item])
        XCTAssertEqual(store.load().first?.state, .waiting, "a send cut off by the app dying goes back to waiting; its clientId makes the resend safe")
    }
    func testToolRunsCollapseIntoOneLine() {
        func ev(_ id: String, _ kind: String) -> AgentEvent { AgentEvent(id: id, kind: kind) }
        let items = TimelineItem.group([ev("u", "user"), ev("t1", "tool"), ev("th", "thinking"), ev("t2", "tool"), ev("t3", "tool"), ev("x", "text"), ev("t4", "tool"), ev("t5", "tool")])
        XCTAssertEqual(items.map { $0.events.map(\.id) }, [["u"], ["t1", "th", "t2", "t3", "x", "t4", "t5"]],
                       "tool steps in a row become one group, and a message followed by more steps is in-between chatter")
        let short = TimelineItem.group([ev("u", "user"), ev("t1", "tool"), ev("t2", "tool"), ev("done", "text")])
        XCTAssertEqual(short.map { $0.events.map(\.id) }, [["u"], ["t1"], ["t2"], ["done"]], "two steps stay as they are")
    }
    func testInBetweenMessagesJoinTheStepsButTheLastOneStaysOut() {
        func ev(_ id: String, _ kind: String) -> AgentEvent { AgentEvent(id: id, kind: kind) }
        let items = TimelineItem.group([ev("t1", "tool"), ev("m1", "text"), ev("t2", "tool"), ev("t3", "tool"), ev("final", "text"), ev("r", "result")])
        XCTAssertEqual(items.map { $0.events.map(\.id) }, [["t1", "m1", "t2", "t3"], ["final"], ["r"]])
    }
    func testSelectableTextRendersInlineMarkdown() {
        let out = SelectableText.render("Use **launchd**, not `pm2`. See [docs](https://example.com).", font: .systemFont(ofSize: 17), color: .white)
        XCTAssertEqual(out.string, "Use launchd, not pm2. See docs.")
        let bold = out.attribute(.font, at: 5, effectiveRange: nil) as? UIFont
        XCTAssertTrue(bold?.fontDescriptor.symbolicTraits.contains(.traitBold) == true)
        let code = out.attribute(.font, at: (out.string as NSString).range(of: "pm2").location, effectiveRange: nil) as? UIFont
        XCTAssertTrue(code?.fontDescriptor.symbolicTraits.contains(.traitMonoSpace) == true)
        XCTAssertNotNil(out.attribute(.link, at: (out.string as NSString).range(of: "docs").location, effectiveRange: nil))
    }
    func testAttachmentsRideInTheMessageAndComeBackOut() {
        let a = Attachment(name: "receipt.jpg", path: "/Users/x/.walkie/uploads/claude:1/1-receipt.jpg", type: "image/jpeg")
        let text = AttachmentText.join("Can you file this?", [a])
        XCTAssertEqual(text, "Can you file this?\n\nAttached:\n- /Users/x/.walkie/uploads/claude:1/1-receipt.jpg")
        let back = AttachmentText.split(text)
        XCTAssertEqual(back.body, "Can you file this?")
        XCTAssertEqual(back.paths, [a.path])
        XCTAssertEqual(AttachmentText.split(AttachmentText.join("", [a])).body, "")
        XCTAssertEqual(AttachmentText.split("No files here").paths, [])
        XCTAssertTrue(AttachmentText.isImage(a.path))
    }
}

private final class MemoryStore: SecureStoring {
    var values: [String: String] = [:]
    func read(_ account: String) -> String? { values[account] }
    func write(_ value: String, account: String) { values[account] = value }
    func remove(_ account: String) { values[account] = nil }

}
