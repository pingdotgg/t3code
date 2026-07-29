import AppKit
import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Animation stability")
struct AnimationStabilityTests {
    private static var sourceRoot: URL {
        var directory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // SergeCodeMacTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // mac
        directory.append(path: "Sources/SergeCodeMac")
        return directory
    }

    @Test("app code avoids the macOS 27 PhaseAnimator executor crash")
    func avoidsPhaseAnimator() throws {
        var offenders: [String] = []
        let enumerator = try #require(
            FileManager.default.enumerator(
                at: Self.sourceRoot,
                includingPropertiesForKeys: nil))

        for case let url as URL in enumerator where url.pathExtension == "swift" {
            let contents = try String(contentsOf: url, encoding: .utf8)
            if contents.contains(".phaseAnimator(") {
                offenders.append(
                    url.path.replacingOccurrences(
                        of: Self.sourceRoot.path + "/",
                        with: ""))
            }
        }

        #expect(
            offenders.isEmpty,
            """
            macOS 27 can crash in phaseAnimator while live views churn.
            Use a static or one-shot state cue instead: \(offenders.joined(separator: ", "))
            """)
    }

    @Test("live row decoration does not own a display clock")
    func liveRowsAvoidDisplayClock() throws {
        let url = Self.sourceRoot.appending(path: "UI/Chat/LiveActivityMotion.swift")
        let contents = try String(contentsOf: url, encoding: .utf8)

        #expect(!contents.contains("TimelineView("))
    }
}

@Suite("Window presentation readiness")
@MainActor
struct WindowPresentationReadyTests {
    @Test("signals only after the containing window is visible")
    func waitsForVisibleWindow() async throws {
        var signalCount = 0
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 40, height: 40),
            styleMask: .borderless,
            backing: .buffered,
            defer: false)
        let probe = WindowPresentationReadyView {
            signalCount += 1
        }
        window.contentView = probe
        defer {
            window.orderOut(nil)
            window.contentView = nil
        }

        try await Task.sleep(for: .milliseconds(40))
        #expect(signalCount == 0)

        window.orderFront(nil)
        try await Task.sleep(for: .milliseconds(50))
        #expect(signalCount == 1)
    }

    @Test("cancels the signal when the probe leaves its window")
    func cancelsWhenDetached() async throws {
        var signalCount = 0
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 40, height: 40),
            styleMask: .borderless,
            backing: .buffered,
            defer: false)
        let probe = WindowPresentationReadyView {
            signalCount += 1
        }
        window.contentView = probe
        window.contentView = nil
        defer { window.orderOut(nil) }

        window.orderFront(nil)
        try await Task.sleep(for: .milliseconds(50))
        #expect(signalCount == 0)
    }
}
