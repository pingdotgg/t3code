import AppKit
import Foundation

// The agent's own pointer.
//
// Desktop control should never fight the person sitting at the machine for
// their mouse, so clicks go straight to a window (see `backgroundClick`) and
// the system cursor is left alone. That leaves nothing on screen to show where
// the agent is working, which is unnerving to watch — so we draw our own
// pointer instead.
//
// AppKit needs a main run loop and this server's main thread is busy reading
// stdio, so the overlay lives in a child process running the same binary in
// `cursor-overlay` mode. It is told where to be over that process's stdin:
//
//     {"x": 400, "y": 260}   move (screen coordinates, top-left origin)
//     {"hide": true}         fade out until the next move

/// Client side: owns the overlay process and speaks to it.
final class AgentCursor {
    static let shared = AgentCursor()

    private var process: Process?
    private var input: FileHandle?
    private let lock = NSLock()

    /// Show the agent pointer at a screen point, starting the overlay if needed.
    ///
    /// Failures are deliberately silent: the overlay is a courtesy, and a
    /// missing pointer must never turn a working click into a failed tool call.
    func show(at point: CGPoint) {
        lock.lock()
        defer { lock.unlock() }
        if process?.isRunning != true { start() }
        send(["x": Int(point.x), "y": Int(point.y)])
    }

    func hide() {
        lock.lock()
        defer { lock.unlock() }
        guard process?.isRunning == true else { return }
        send(["hide": true])
    }

    private func start() {
        let child = Process()
        child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
        child.arguments = ["cursor-overlay"]
        let pipe = Pipe()
        child.standardInput = pipe
        // The overlay is chatty on stderr when a display goes away; that is not
        // this process's problem.
        child.standardError = FileHandle.nullDevice
        do {
            try child.run()
        } catch {
            return
        }
        process = child
        input = pipe.fileHandleForWriting
    }

    private func send(_ message: [String: Any]) {
        guard let input,
            var data = try? JSONSerialization.data(withJSONObject: message)
        else { return }
        data.append(0x0A)
        // The overlay may have been killed by the user; a broken pipe raises
        // SIGPIPE-as-error here, which we swallow and retry on the next call.
        try? input.write(contentsOf: data)
    }
}

/// The overlay process itself.
enum AgentCursorOverlay {
    static func run() -> Never {
        let application = NSApplication.shared
        // .accessory keeps it out of the Dock and stops it stealing focus.
        application.setActivationPolicy(.accessory)
        let controller = OverlayController()
        application.delegate = controller
        controller.listen()
        application.run()
        exit(0)
    }
}

private final class OverlayController: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private var hideTimer: Timer?

    /// Big enough for the pointer plus its halo, small enough to never occlude
    /// anything the agent is about to click.
    private static let size = CGSize(width: 44, height: 44)

    func applicationDidFinishLaunching(_ notification: Notification) {
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: Self.size),
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        // Above ordinary windows and full-screen apps, but still below system
        // alerts so it can never hide something the user must answer.
        window.level = .statusBar
        // The whole point: the overlay must not intercept a single event.
        window.ignoresMouseEvents = true
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        window.contentView = PointerView(frame: NSRect(origin: .zero, size: Self.size))
        window.alphaValue = 0
        window.orderFrontRegardless()
        self.window = window
    }

    /// Read move/hide commands off stdin without blocking the run loop.
    func listen() {
        let handle = FileHandle.standardInput
        handle.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty {
                // The server exited; take the pointer with it.
                DispatchQueue.main.async { NSApplication.shared.terminate(nil) }
                return
            }
            for line in String(decoding: data, as: UTF8.self).split(separator: "\n") {
                guard let payload = line.data(using: .utf8),
                    let message = try? JSONSerialization.jsonObject(with: payload)
                        as? [String: Any]
                else { continue }
                DispatchQueue.main.async { self?.handle(message) }
            }
        }
    }

    private func handle(_ message: [String: Any]) {
        if message["hide"] as? Bool == true {
            fade(to: 0)
            return
        }
        guard let x = message["x"] as? Int, let y = message["y"] as? Int else { return }
        move(to: CGPoint(x: x, y: y))
    }

    private func move(to point: CGPoint) {
        guard let window else { return }
        // Callers work in screen coordinates with a top-left origin, matching
        // screenshots and the accessibility API; AppKit's are bottom-left.
        let flipped = (NSScreen.screens.first?.frame.height ?? 0) - point.y
        let origin = NSPoint(x: point.x - 6, y: flipped - Self.size.height + 6)
        window.setFrameOrigin(origin)
        fade(to: 1)

        // Linger briefly after the last action, then fade: a pointer parked on
        // screen indefinitely reads as though the agent is still working.
        hideTimer?.invalidate()
        hideTimer = Timer.scheduledTimer(withTimeInterval: 2.5, repeats: false) { [weak self] _ in
            self?.fade(to: 0)
        }
    }

    private func fade(to alpha: CGFloat) {
        guard let window, window.alphaValue != alpha else { return }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = alpha == 0 ? 0.35 : 0.12
            window.animator().alphaValue = alpha
        }
    }
}

/// Draws the pointer: an arrow in T3 Code's accent, ringed so it stays legible
/// on any wallpaper and cannot be mistaken for the system cursor.
private final class PointerView: NSView {
    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        let accent = NSColor(srgbRed: 0.29, green: 0.44, blue: 0.98, alpha: 1)

        // A soft halo, so the pointer reads against dark and light backgrounds.
        context.setFillColor(accent.withAlphaComponent(0.22).cgColor)
        context.fillEllipse(in: CGRect(x: 2, y: 2, width: 26, height: 26))

        let arrow = NSBezierPath()
        arrow.move(to: NSPoint(x: 8, y: 6))
        arrow.line(to: NSPoint(x: 8, y: 25))
        arrow.line(to: NSPoint(x: 13, y: 20))
        arrow.line(to: NSPoint(x: 16.5, y: 28))
        arrow.line(to: NSPoint(x: 20, y: 26.5))
        arrow.line(to: NSPoint(x: 16.5, y: 18.5))
        arrow.line(to: NSPoint(x: 23, y: 18))
        arrow.close()

        context.saveGState()
        context.setShadow(offset: .zero, blur: 3, color: NSColor.black.withAlphaComponent(0.45).cgColor)
        accent.setFill()
        arrow.fill()
        context.restoreGState()

        NSColor.white.setStroke()
        arrow.lineWidth = 1.5
        arrow.stroke()
    }
}
