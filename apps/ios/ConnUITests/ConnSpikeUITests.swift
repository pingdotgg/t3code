import XCTest

@MainActor
final class ConnSpikeUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testWave2EndToEndFlow() throws {
        let env = ProcessInfo.processInfo.environment
        guard let pairingURL = env["CONN_PAIRING_URL"], !pairingURL.isEmpty else {
            throw XCTSkip("Set CONN_PAIRING_URL to run the live server E2E test")
        }
        let screensDir = env["CONN_SCREENS_DIR"]
        let themeSuffix = env["CONN_SCREEN_SUFFIX"] ?? ""
        let expectedThreadTitle = env["CONN_THREAD_TITLE"] ?? "Hello from conn-server"
        let expectedReplySnippet = env["CONN_REPLY_SNIPPET"] ?? "Hello"
        let runMutations = env["CONN_SKIP_MUTATIONS"] != "1"

        let app = XCUIApplication()
        app.launchArguments = ["--reset-session"]
        app.launch()

        // 1. Pair
        let urlField = app.textFields["pairing.urlField"]
        XCTAssertTrue(urlField.waitForExistence(timeout: 10), "Pairing URL field should appear")
        urlField.tap()
        urlField.typeText(pairingURL)

        let connectButton = app.buttons["pairing.connectButton"]
        XCTAssertTrue(connectButton.waitForExistence(timeout: 5))
        connectButton.tap()

        // 2. Inbox
        let threadRow = app.staticTexts[expectedThreadTitle].firstMatch
        XCTAssertTrue(threadRow.waitForExistence(timeout: 15), "Seeded thread should appear in inbox")
        RunLoop.current.run(until: Date().addingTimeInterval(0.6))
        saveScreenshot(named: "inbox\(themeSuffix)", dir: screensDir)

        // 3. Open thread
        threadRow.tap()

        let replyText = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", expectedReplySnippet)).firstMatch
        XCTAssertTrue(replyText.waitForExistence(timeout: 15), "Thread timeline should render existing assistant reply")
        RunLoop.current.run(until: Date().addingTimeInterval(0.6))
        saveScreenshot(named: "thread\(themeSuffix)", dir: screensDir)

        if runMutations {
            // 4. Send message
            let composer = app.textViews["Message…"].exists
                ? app.textViews["Message…"]
                : app.textFields["Message…"].firstMatch
            XCTAssertTrue(composer.waitForExistence(timeout: 10), "Composer field should exist")
            composer.tap()
            composer.typeText("Reply with just OK.")

            let sendButton = app.buttons["Send"].firstMatch
            XCTAssertTrue(sendButton.waitForExistence(timeout: 5))
            sendButton.tap()

            let sentBubble = app.staticTexts["Reply with just OK."].firstMatch
            XCTAssertTrue(sentBubble.waitForExistence(timeout: 15), "Sent message should appear in timeline")
            RunLoop.current.run(until: Date().addingTimeInterval(0.8))
            saveScreenshot(named: "composer-working\(themeSuffix)", dir: screensDir)

            // 5. Back to inbox & settle via swipe
            app.navigationBars.buttons.element(boundBy: 0).tap()
            XCTAssertTrue(threadRow.waitForExistence(timeout: 10), "Should return to inbox")
            threadRow.swipeLeft()

            let settleButton = app.buttons["Settle"].firstMatch
            if settleButton.waitForExistence(timeout: 5) {
                settleButton.tap()
            }
            let settledHeader = app.buttons["inbox.settledHeader"].firstMatch
            XCTAssertTrue(settledHeader.waitForExistence(timeout: 10), "Settled shelf should appear after settling")

            // 6. New thread via launch
            let newThreadButton = app.buttons["inbox.newThreadButton"].firstMatch
            XCTAssertTrue(newThreadButton.waitForExistence(timeout: 5))
            newThreadButton.tap()

            let promptField = app.textViews["newThread.promptField"].exists
                ? app.textViews["newThread.promptField"]
                : app.textFields["newThread.promptField"].firstMatch
            XCTAssertTrue(promptField.waitForExistence(timeout: 10), "New thread prompt field should appear")
            saveScreenshot(named: "new-thread\(themeSuffix)", dir: screensDir)

            promptField.tap()
            promptField.typeText("Say hi from wave2")

            let startButton = app.buttons["newThread.startButton"].firstMatch
            XCTAssertTrue(startButton.waitForExistence(timeout: 5))
            startButton.tap()

            let launchedBubble = app.staticTexts["Say hi from wave2"].firstMatch
            XCTAssertTrue(launchedBubble.waitForExistence(timeout: 20), "Launched thread should open with initial message")
        } else {
            // Screenshot-only pass (e.g. light mode)
            app.navigationBars.buttons.element(boundBy: 0).tap()
            let newThreadButton = app.buttons["inbox.newThreadButton"].firstMatch
            XCTAssertTrue(newThreadButton.waitForExistence(timeout: 5))
            newThreadButton.tap()
            let promptField = app.textViews["newThread.promptField"].exists
                ? app.textViews["newThread.promptField"]
                : app.textFields["newThread.promptField"].firstMatch
            XCTAssertTrue(promptField.waitForExistence(timeout: 10))
            saveScreenshot(named: "new-thread\(themeSuffix)", dir: screensDir)
        }
    }

    private func saveScreenshot(named name: String, dir: String?) {
        guard let dir, !dir.isEmpty else { return }
        let directory = URL(fileURLWithPath: dir, isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = XCUIScreen.main.screenshot().pngRepresentation
        let fileURL = directory.appendingPathComponent("\(name).png")
        try? data.write(to: fileURL)
    }
}
