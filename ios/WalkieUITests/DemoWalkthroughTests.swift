import XCTest

// Drives the built-in demo the way a reviewer would, slowly enough to record. Run with
// `xcrun simctl io <udid> recordVideo` alongside to get the App Review walkthrough.
final class DemoWalkthroughTests: XCTestCase {
    func testDemoWalkthrough() {
        let app = XCUIApplication()
        app.launchArguments = ["-walkieUnpair", "YES", "-walkieNoPush", "YES"]
        app.launch()
        let pause: TimeInterval = ProcessInfo.processInfo.environment["WALKIE_SLOW"] == "1" ? 2.2 : 0.3
        func beat() { Thread.sleep(forTimeInterval: pause) }

        beat()
        let demo = app.buttons["See it work without a Mac"]
        XCTAssertTrue(demo.waitForExistence(timeout: 10))
        beat(); demo.tap()

        // Home: meters, Needs you, conversations.
        let waiting = app.staticTexts["Fix the login button on iPad"]
        XCTAssertTrue(waiting.waitForExistence(timeout: 10))
        beat(); beat()
        waiting.tap()

        // A permission card; allow it and watch the reply land.
        let allow = app.buttons["Allow"]
        XCTAssertTrue(allow.waitForExistence(timeout: 10))
        beat(); beat()
        allow.tap()
        // Replies render in a text view; the result line under them is a plain label.
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Done'")).firstMatch.waitForExistence(timeout: 15))
        beat(); beat()

        // Back home, open the planning conversation and its plan.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        let planning = app.staticTexts["Monday planning"]
        XCTAssertTrue(planning.waitForExistence(timeout: 10))
        beat(); planning.tap()
        let review = app.buttons["Review and start"]
        XCTAssertTrue(review.waitForExistence(timeout: 10))
        beat(); beat(); review.tap()
        XCTAssertTrue(app.navigationBars["Send to projects"].waitForExistence(timeout: 10))
        beat(); beat(); beat()
        app.buttons["Cancel"].tap()
        beat()

        // The purchase sheet from Settings.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        let settings = app.buttons["Settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 10))
        beat(); settings.tap()
        let buy = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Use all subscriptions'")).firstMatch
        if buy.waitForExistence(timeout: 5) {
            beat(); buy.tap()
            XCTAssertTrue(app.staticTexts["Walkie for all subscriptions"].waitForExistence(timeout: 10))
            beat(); beat(); beat()
        } else {
            beat(); beat()
        }
    }
}
