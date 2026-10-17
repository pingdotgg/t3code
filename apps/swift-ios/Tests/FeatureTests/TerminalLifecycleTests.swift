import Testing
import UIKit
@testable import T3Code

@MainActor
struct TerminalLifecycleTests {
    @Test func closingTerminalDoesNotRecreateRendererDuringDismissal() async throws {
        let view = GhosttyTerminalView()
        view.frame = CGRect(x: 0, y: 0, width: 390, height: 600)
        view.layoutIfNeeded()
        let viewport = try #require(view.subviews.first)
        #expect(!(viewport.layer.sublayers ?? []).isEmpty)
        view.buffer = "$ printf hello\r\nhello\r\n$ "
        let cleanup = view.tearDown()
        // SwiftUI can still lay out the outgoing view while its sheet closes.
        view.setNeedsLayout()
        view.layoutIfNeeded()
        view.buffer += "late output\r\n"
        view.fontSize = 14
        view.isDarkMode = false
        view.terminalKey = "late-session-update"
        view.layoutIfNeeded()
        #expect((viewport.layer.sublayers ?? []).isEmpty)
        view.tearDown()
        await cleanup?.value
    }

    @Test func closingTerminalReleasesKeyboardAndNativeOwner() async throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 600))
        let controller = UIViewController()
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        weak var releasedView: GhosttyTerminalView?
        var cleanup: Task<Void, Never>?
        do {
            let view = GhosttyTerminalView()
            releasedView = view
            view.frame = controller.view.bounds
            controller.view.addSubview(view)
            view.isRunning = true
            view.layoutIfNeeded()
            let input = try #require(view.subviews.compactMap { $0 as? UITextField }.first)
            #expect(input.becomeFirstResponder())
            view.buffer = "$ command\r\n" + String(repeating: "command output\r\n", count: 200)
            cleanup = view.tearDown()
            #expect(!input.isFirstResponder)
            view.removeFromSuperview()
        }
        await cleanup?.value
        cleanup = nil
        await drainMainQueue()
        #expect(releasedView == nil)
    }

    private func drainMainQueue() async {
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }
    }

    @Test func terminalDrainsHostMessagesBeforeClosing() async {
        let view = GhosttyTerminalView()
        view.frame = CGRect(x: 0, y: 0, width: 390, height: 600)
        view.layoutIfNeeded()
        // More title updates than Ghostty's 64-entry host mailbox holds.
        // The status reply proves its I/O worker processed all preceding output.
        let output = (0..<200).map { "\u{1B}]2;Command \($0)\u{07}" }.joined() + "\u{1B}[5n"
        await withCheckedContinuation { continuation in
            var completed = false
            view.onInput = { response in
                guard !completed, response.contains("\u{1B}[0n") else { return }
                completed = true
                continuation.resume()
            }
            view.buffer = output
        }
        await view.tearDown()?.value
    }

    @Test(arguments: [1, 64, 200, 1_000])
    func closesWhileHostMessagesAreStillBeingProcessed(count: Int) async {
        let view = GhosttyTerminalView()
        view.frame = CGRect(x: 0, y: 0, width: 390, height: 600)
        view.layoutIfNeeded()
        view.buffer = (0..<count).map { "\u{1B}]2;Command \($0)\u{07}" }.joined()
        await view.tearDown()?.value
    }

    @Test func replacingRendererNeverWritesCleanupMarkerToHost() async {
        let view = GhosttyTerminalView()
        view.frame = CGRect(x: 0, y: 0, width: 390, height: 600)
        view.layoutIfNeeded()
        var sent: [String] = []
        view.onInput = { sent.append($0) }
        view.buffer = "\u{1B}[?2004h$ command\r\noutput\r\n"
        view.fontSize = 15
        view.isDarkMode = false
        await view.tearDown()?.value
        await drainMainQueue()
        #expect(sent.isEmpty)
    }
}
