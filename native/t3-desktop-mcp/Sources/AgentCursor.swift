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
// AppKit needs a real application bundle to put a window up: a bare executable
// started with `Process` never finishes launching, so the overlay stays
// invisible and silent. The pointer therefore lives in a minimal
// `T3AgentCursor.app`. Preferred launch is `NSWorkspace` (registers with
// Launch Services); if that fails we fall back to `Process` aimed at the
// bundled executable, which still gets a real `Bundle.main`. Move/hide
// commands ride a Unix socket:
//
//     {"x": 400, "y": 260}              move (screen coordinates, top-left origin)
//     {"x": 400, "y": 260, "press": true}  move and play the click pop/ripple
//     {"hide": true}                    fade out until the next move
//
// The look is the soft translucent bubble (lavender glow, rounded
// arrow, spring/squash/click pop) — never a system-style pointer, so it
// cannot be mistaken for the user's own cursor.

private let overlayAppName = "T3AgentCursor.app"
private let overlayExecutableName = "T3AgentCursor"
private let overlayBundleIdentifier = "com.t3tools.t3code.agent-cursor"

/// Client side: owns the overlay process and speaks to it.
final class AgentCursor {
    static let shared = AgentCursor()

    private var connection: FileHandle?
    private var listenerSource: DispatchSourceRead?
    private var listenerFD: Int32 = -1
    private var socketPath: String?
    private var pending: [[String: Any]] = []
    private var process: Process?
    private let lock = NSLock()

    /// Show the agent pointer at a screen point, starting the overlay if needed.
    ///
    /// Failures are deliberately silent toward the tool caller: the overlay is
    /// a courtesy, and a missing pointer must never turn a working click into a
    /// failed tool call. Launch problems still go to stderr so they are
    /// diagnosable without poisoning the MCP response.
    func show(at point: CGPoint) {
        guard agentCursorEnabled else { return }
        send(point: point, press: false)
    }

    /// Move and play the click pop + ripple.
    func press(at point: CGPoint) {
        guard agentCursorEnabled else { return }
        send(point: point, press: true)
    }

    func hide() {
        lock.lock()
        defer { lock.unlock() }
        guard connection != nil || listenerFD >= 0 else { return }
        sendLocked(["hide": true])
    }

    private func send(point: CGPoint, press: Bool) {
        lock.lock()
        defer { lock.unlock() }
        ensureRunning()
        // If the overlay could not start, drop the event instead of queuing
        // forever and growing `pending` for the lifetime of the MCP server.
        guard connection != nil || listenerFD >= 0 else { return }
        var message: [String: Any] = ["x": Int(point.x), "y": Int(point.y)]
        if press { message["press"] = true }
        sendLocked(message)
    }

    private func ensureRunning() {
        if connection != nil { return }
        if listenerFD >= 0 { return }

        guard let appURL = OverlayBundle.ensureApp() else {
            fputs("t3-desktop-mcp: agent cursor: could not materialise T3AgentCursor.app\n", stderr)
            return
        }

        // sockaddr_un.sun_path is only 104 bytes on macOS; NSTemporaryDirectory()
        // under /var/folders/... plus a UUID blows past that and bind() fails,
        // which is why the overlay never started from the MCP server.
        let path = "/tmp/t3ac-\(getpid()).sock"
        guard startListening(at: path) else {
            fputs("t3-desktop-mcp: agent cursor: could not listen on \(path)\n", stderr)
            return
        }
        socketPath = path

        let executable = appURL
            .appendingPathComponent("Contents", isDirectory: true)
            .appendingPathComponent("MacOS", isDirectory: true)
            .appendingPathComponent(overlayExecutableName)

        // Fresh copies need an LS registration before openApplication will
        // resolve the bundle; without this the completion returns an error and
        // the pointer never appears after a rebuild.
        LSRegisterURL(appURL as CFURL, true)

        let configuration = NSWorkspace.OpenConfiguration()
        configuration.arguments = ["cursor-overlay", "--socket", path]
        configuration.activates = false
        configuration.addsToRecentItems = false
        configuration.createsNewApplicationInstance = true

        NSWorkspace.shared.openApplication(at: appURL, configuration: configuration) { [weak self] _, error in
            guard let self else { return }
            if let error {
                fputs(
                    "t3-desktop-mcp: agent cursor: NSWorkspace open failed (\(error.localizedDescription)); falling back to Process\n",
                    stderr
                )
                self.lock.lock()
                self.launchViaProcess(executable: executable, socketPath: path)
                self.lock.unlock()
            }
        }

        // If NSWorkspace is slow or silent, arm a Process fallback shortly.
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.8) { [weak self] in
            guard let self else { return }
            self.lock.lock()
            defer { self.lock.unlock() }
            if self.connection == nil, self.process?.isRunning != true, self.socketPath == path {
                fputs("t3-desktop-mcp: agent cursor: NSWorkspace timed out; falling back to Process\n", stderr)
                self.launchViaProcess(executable: executable, socketPath: path)
            }
        }
    }

    private func launchViaProcess(executable: URL, socketPath: String) {
        if process?.isRunning == true { return }
        if connection != nil { return }
        let child = Process()
        child.executableURL = executable
        child.arguments = ["cursor-overlay", "--socket", socketPath]
        child.standardInput = FileHandle.nullDevice
        child.standardOutput = FileHandle.nullDevice
        child.standardError = FileHandle.nullDevice
        do {
            try child.run()
            process = child
        } catch {
            fputs("t3-desktop-mcp: agent cursor: Process launch failed (\(error.localizedDescription))\n", stderr)
            tearDownLocked()
        }
    }

    private func sendLocked(_ message: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: message) else { return }
        var line = data
        line.append(0x0A)
        if let connection {
            // The overlay may have been killed by the user; a broken pipe raises
            // here, which we swallow and retry on the next call.
            do {
                try connection.write(contentsOf: line)
            } catch {
                tearDownLocked()
            }
            return
        }
        pending.append(message)
    }

    private func startListening(at path: String) -> Bool {
        unlink(path)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = path.utf8CString
        guard pathBytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
            close(fd)
            return false
        }
        withUnsafeMutablePointer(to: &address.sun_path) { ptr in
            ptr.withMemoryRebound(to: CChar.self, capacity: pathBytes.count) { dest in
                for (index, byte) in pathBytes.enumerated() {
                    dest[index] = byte
                }
            }
        }

        let bindResult = withUnsafePointer(to: &address) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                bind(fd, sockPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bindResult == 0, listen(fd, 1) == 0 else {
            close(fd)
            unlink(path)
            return false
        }

        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .main)
        source.setEventHandler { [weak self] in
            self?.acceptConnection()
        }
        source.setCancelHandler {
            close(fd)
        }
        source.resume()
        listenerFD = fd
        listenerSource = source
        return true
    }

    private func acceptConnection() {
        lock.lock()
        defer { lock.unlock() }
        guard listenerFD >= 0 else { return }
        let client = accept(listenerFD, nil, nil)
        guard client >= 0 else { return }
        enableNoSigPipe(client)

        listenerSource?.cancel()
        listenerSource = nil
        listenerFD = -1
        if let socketPath {
            unlink(socketPath)
            self.socketPath = nil
        }

        let handle = FileHandle(fileDescriptor: client, closeOnDealloc: true)
        connection = handle
        let queued = pending
        pending.removeAll()
        for message in queued {
            sendLocked(message)
        }
    }

    private func tearDownLocked() {
        // Cancel handler owns closing the listener FD — do not double-close.
        if let source = listenerSource {
            listenerSource = nil
            listenerFD = -1
            source.cancel()
        } else if listenerFD >= 0 {
            close(listenerFD)
            listenerFD = -1
        }
        if let socketPath {
            unlink(socketPath)
            self.socketPath = nil
        }
        try? connection?.close()
        connection = nil
        if let process, process.isRunning {
            process.terminate()
        }
        process = nil
        pending.removeAll()
    }
}

/// Builds or locates the overlay `.app` next to the MCP binary (or under
/// Application Support for a bare SwiftPM build).
private enum OverlayBundle {
    static func ensureApp() -> URL? {
        let fm = FileManager.default
        let selfURL = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()

        // Staged artifact: `…/t3-desktop-mcp/T3AgentCursor.app` beside the binary.
        let sibling = selfURL.deletingLastPathComponent().appendingPathComponent(overlayAppName)
        if isValidApp(sibling) {
            do {
                try refreshExecutable(in: sibling, from: selfURL)
                return sibling
            } catch {
                return isValidApp(sibling) ? sibling : nil
            }
        }

        // Dev / unsigned: materialise under Application Support so Launch Services
        // sees a stable path across rebuilds.
        guard
            let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return nil }
        let dir = support.appendingPathComponent("t3-desktop-mcp", isDirectory: true)
        let appURL = dir.appendingPathComponent(overlayAppName, isDirectory: true)
        do {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            try materialize(at: appURL, executable: selfURL)
            return appURL
        } catch {
            return nil
        }
    }

    private static func isValidApp(_ appURL: URL) -> Bool {
        let fm = FileManager.default
        let exe = appURL
            .appendingPathComponent("Contents", isDirectory: true)
            .appendingPathComponent("MacOS", isDirectory: true)
            .appendingPathComponent(overlayExecutableName)
        let plist = appURL
            .appendingPathComponent("Contents", isDirectory: true)
            .appendingPathComponent("Info.plist")
        return fm.fileExists(atPath: exe.path) && fm.fileExists(atPath: plist.path)
    }

    private static func materialize(at appURL: URL, executable: URL) throws {
        let fm = FileManager.default
        let contents = appURL.appendingPathComponent("Contents", isDirectory: true)
        let macOS = contents.appendingPathComponent("MacOS", isDirectory: true)
        try fm.createDirectory(at: macOS, withIntermediateDirectories: true)

        let plistURL = contents.appendingPathComponent("Info.plist")
        if !fm.fileExists(atPath: plistURL.path) {
            try overlayInfoPlist().write(to: plistURL, atomically: true, encoding: .utf8)
        }

        try refreshExecutable(in: appURL, from: executable)
    }

    /// Keep the bundled binary in sync with the running MCP server so a rebuild
    /// is picked up without a manual wipe of Application Support.
    private static func refreshExecutable(in appURL: URL, from executable: URL) throws {
        let fm = FileManager.default
        let dest = appURL
            .appendingPathComponent("Contents", isDirectory: true)
            .appendingPathComponent("MacOS", isDirectory: true)
            .appendingPathComponent(overlayExecutableName)
        // Skip the copy when we *are* the bundled binary (overlay relaunching).
        if executable.resolvingSymlinksInPath() == dest.resolvingSymlinksInPath() { return }

        let needsCopy: Bool
        if !fm.fileExists(atPath: dest.path) {
            needsCopy = true
        } else if
            let src = try? executable.resourceValues(forKeys: [.contentModificationDateKey])
            .contentModificationDate,
            let dst = try? dest.resourceValues(forKeys: [.contentModificationDateKey])
            .contentModificationDate
        {
            needsCopy = src > dst
        } else {
            needsCopy = true
        }
        guard needsCopy else { return }
        try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
        // Copy to a temp name first so a failed refresh never leaves dest deleted.
        let temp = dest.deletingLastPathComponent()
            .appendingPathComponent(".\(overlayExecutableName).new")
        try? fm.removeItem(at: temp)
        try fm.copyItem(at: executable, to: temp)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: temp.path)
        if fm.fileExists(atPath: dest.path) {
            try fm.removeItem(at: dest)
        }
        try fm.moveItem(at: temp, to: dest)
    }

    private static func overlayInfoPlist() -> String {
        """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
        	<key>CFBundleDevelopmentRegion</key>
        	<string>en</string>
        	<key>CFBundleExecutable</key>
        	<string>\(overlayExecutableName)</string>
        	<key>CFBundleIdentifier</key>
        	<string>\(overlayBundleIdentifier)</string>
        	<key>CFBundleInfoDictionaryVersion</key>
        	<string>6.0</string>
        	<key>CFBundleName</key>
        	<string>T3 Agent Cursor</string>
        	<key>CFBundlePackageType</key>
        	<string>APPL</string>
        	<key>CFBundleShortVersionString</key>
        	<string>1.0</string>
        	<key>CFBundleVersion</key>
        	<string>1</string>
        	<key>LSMinimumSystemVersion</key>
        	<string>14.0</string>
        	<key>LSUIElement</key>
        	<true/>
        	<key>NSHighResolutionCapable</key>
        	<true/>
        	<key>NSPrincipalClass</key>
        	<string>NSApplication</string>
        </dict>
        </plist>
        """
    }
}

/// The overlay process itself.
enum AgentCursorOverlay {
    static func run(socketPath: String) -> Never {
        let application = NSApplication.shared
        // .accessory keeps it out of the Dock and stops it stealing focus.
        // LSUIElement in Info.plist does the same for Launch Services.
        application.setActivationPolicy(.accessory)
        let controller = OverlayController(socketPath: socketPath)
        application.delegate = controller
        // Build the window here rather than waiting for
        // applicationDidFinishLaunching: even inside a bundle the callback can
        // race the first move command, and an empty window list meant the
        // pointer never appeared for that click.
        controller.makeWindow()
        controller.listen()
        // NSApplication.delegate is weak; keep the controller alive for the run loop.
        withExtendedLifetime(controller) {
            application.run()
        }
        exit(0)
    }
}

private final class OverlayController: NSObject, NSApplicationDelegate {
    private let socketPath: String
    private var panel: NSPanel?
    private var view: BubbleView?
    private var socketHandle: FileHandle?
    private var socketBuffer = Data()
    private var animation: Timer?
    private var hideWork: DispatchWorkItem?

    /// Generous panel so the glow, squash and click ripple all have room.
    private let side: CGFloat = 112
    /// Distance from the panel's top-left corner to the cursor's hot point.
    fileprivate static let hotspot: CGFloat = 56

    /// Spring state, in Quartz screen coordinates.
    private var current: CGPoint?
    private var target: CGPoint = .zero
    private var velocity: CGVector = .zero

    init(socketPath: String) {
        self.socketPath = socketPath
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        makeWindow()
    }

    func makeWindow() {
        guard panel == nil else { return }
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: side, height: side),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        // Above ordinary windows and full-screen apps, but still below system
        // alerts so it can never hide something the user must answer.
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        let view = BubbleView(frame: NSRect(x: 0, y: 0, width: side, height: side))
        panel.contentView = view
        panel.alphaValue = 0
        self.panel = panel
        self.view = view
    }

    /// Connect to the server's socket and read move/hide commands without
    /// blocking the run loop.
    func listen() {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            NSApplication.shared.terminate(nil)
            return
        }

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = socketPath.utf8CString
        guard pathBytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
            close(fd)
            NSApplication.shared.terminate(nil)
            return
        }
        withUnsafeMutablePointer(to: &address.sun_path) { ptr in
            ptr.withMemoryRebound(to: CChar.self, capacity: pathBytes.count) { dest in
                for (index, byte) in pathBytes.enumerated() {
                    dest[index] = byte
                }
            }
        }

        // The parent listens before openApplication returns; retry briefly in
        // case Launch Services schedules us first.
        var connected = false
        for _ in 0..<50 {
            let result = withUnsafePointer(to: &address) { ptr in
                ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                    connect(fd, sockPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
            if result == 0 {
                connected = true
                break
            }
            usleep(20_000)
        }
        guard connected else {
            close(fd)
            NSApplication.shared.terminate(nil)
            return
        }

        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        socketHandle = handle
        handle.readabilityHandler = { [weak self] handle in
            guard let self else { return }
            let data = handle.availableData
            if data.isEmpty {
                // The server exited; take the pointer with it.
                DispatchQueue.main.async { NSApplication.shared.terminate(nil) }
                return
            }
            self.socketBuffer.append(data)
            while let newline = self.socketBuffer.firstIndex(of: 0x0A) {
                let line = self.socketBuffer[self.socketBuffer.startIndex..<newline]
                self.socketBuffer = self.socketBuffer[self.socketBuffer.index(after: newline)...]
                guard !line.isEmpty,
                    let message = try? JSONSerialization.jsonObject(with: Data(line))
                        as? [String: Any]
                else { continue }
                DispatchQueue.main.async { self.handle(message) }
            }
        }
    }

    private func handle(_ message: [String: Any]) {
        if message["hide"] as? Bool == true {
            fadeOut()
            return
        }
        guard let x = message["x"] as? Int, let y = message["y"] as? Int else { return }
        begin(CGPoint(x: x, y: y), popping: message["press"] as? Bool == true)
    }

    private func begin(_ point: CGPoint, popping: Bool) {
        let panel = ensurePanel()
        target = point
        // A first appearance should not fly in from a stale position.
        if current == nil || !panel.isVisible || panel.alphaValue < 0.05 {
            current = point
            velocity = .zero
        }
        place(current ?? point)

        // Appear instantly: AppKit's animator is unreliable in an LSUIElement
        // helper that has no activation. The pointer has to be visible for the
        // click it is announcing.
        if !panel.isVisible || panel.alphaValue < 0.05 {
            panel.alphaValue = 1
            panel.orderFrontRegardless()
        } else {
            panel.alphaValue = 1
        }

        if popping {
            view?.ripple = 0
            view?.pop = 0
            view?.wobble = max(view?.wobble ?? 0, 0.9)
        }

        hideWork?.cancel()
        // Linger long enough for the spring/tilt settle to finish before fade.
        let work = DispatchWorkItem { [weak self] in self?.fadeOut() }
        hideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.4, execute: work)
        startAnimating()
    }

    private func ensurePanel() -> NSPanel {
        if let panel { return panel }
        makeWindow()
        return panel!
    }

    private func startAnimating() {
        guard animation == nil else { return }
        let timer = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(timer, forMode: .common)
        animation = timer
    }

    private func tick() {
        guard let view else { return }
        var busy = false

        if var cur = current {
            // Spring toward the target: stiffness pulls, damping keeps the
            // overshoot to a gentle bounce rather than a wobble.
            let dx = target.x - cur.x, dy = target.y - cur.y
            velocity.dx = (velocity.dx + dx * 0.34) * 0.62
            velocity.dy = (velocity.dy + dy * 0.34) * 0.62
            if abs(dx) < 0.3, abs(dy) < 0.3, abs(velocity.dx) < 0.3, abs(velocity.dy) < 0.3 {
                cur = target
                velocity = .zero
            } else {
                cur.x += velocity.dx
                cur.y += velocity.dy
                busy = true
            }
            current = cur
            view.velocity = velocity
            let speed = sqrt(velocity.dx * velocity.dx + velocity.dy * velocity.dy)
            view.wobble = max(view.wobble * 0.88, min(speed / 26, 1.15))
            view.wobblePhase += 0.78

            // Bank into the travel — lean hard enough that the rotate is obvious
            // on short Day→Week hops, then ease upright on settle.
            let targetTilt = max(-0.9, min(0.9, -velocity.dx * 0.032 + velocity.dy * 0.012))
            view.tilt += (targetTilt - view.tilt) * 0.28
            if abs(view.tilt) > 0.004 { busy = true } else { view.tilt = 0 }

            place(cur)
        }

        if let r = view.ripple {
            let next = r + (1.0 / 60.0) / 0.5
            view.ripple = next >= 1 ? nil : next
            busy = true
        }
        if let p = view.pop {
            let next = p + (1.0 / 60.0) / 0.36
            view.pop = next >= 1 ? nil : next
            busy = true
        }

        if view.wobble > 0.01 { busy = true } else { view.wobble = 0 }
        if panel?.isVisible == true, (panel?.alphaValue ?? 0) > 0.05 {
            view.phase += 0.08
            busy = true
        }
        view.needsDisplay = true

        if !busy {
            animation?.invalidate()
            animation = nil
        }
    }

    private func place(_ point: CGPoint) {
        guard let panel, let mainScreen = NSScreen.screens.first else { return }
        // Quartz measures y downward from the top of the main display; AppKit
        // measures it upward from the bottom.
        let flippedY = mainScreen.frame.maxY - point.y
        panel.setFrameOrigin(NSPoint(
            x: point.x - OverlayController.hotspot,
            y: flippedY - side + OverlayController.hotspot
        ))
    }

    private func fadeOut() {
        guard let panel, panel.isVisible else { return }
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.25
            panel.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            guard let self else { return }
            if panel.alphaValue < 0.05 {
                panel.orderOut(nil)
                self.animation?.invalidate()
                self.animation = nil
            }
        })
    }
}

/// Soft translucent bubble: lavender glow, rounded arrow, squash on travel
/// and a click ripple. Deliberately not a system pointer.
private final class BubbleView: NSView {
    /// 0…1 while a click ripple plays, nil otherwise.
    var ripple: CGFloat?
    /// 0…1 while the bubble pops on click, nil otherwise.
    var pop: CGFloat?
    /// Slow idle breathing so a resting cursor still reads as alive.
    var phase: CGFloat = 0
    /// Current travel, used for squash-and-stretch.
    var velocity: CGVector = .zero
    /// Lean, in radians. Banks into the direction of travel and eases back
    /// to upright when the cursor settles.
    var tilt: CGFloat = 0
    /// Jelly wobble: amplitude builds with speed and decays after the
    /// bubble stops, so it keeps jiggling for a moment on arrival.
    var wobble: CGFloat = 0
    var wobblePhase: CGFloat = 0

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let tip = CGPoint(x: OverlayController.hotspot, y: bounds.maxY - OverlayController.hotspot)

        let lavender = NSColor(calibratedRed: 0.76, green: 0.72, blue: 0.99, alpha: 1)
        let purple = NSColor(calibratedRed: 0.58, green: 0.52, blue: 0.94, alpha: 1)
        let breathe = 1 + 0.03 * sin(phase)

        // Ripple on click, drawn under everything else.
        if let ripple {
            let eased = 1 - pow(1 - ripple, 3)
            let r = 16 + eased * 26
            ctx.setStrokeColor(NSColor.white.withAlphaComponent((1 - eased) * 0.55).cgColor)
            ctx.setLineWidth(3.0 * (1 - eased) + 0.5)
            ctx.strokeEllipse(in: CGRect(x: tip.x - r, y: tip.y - r, width: r * 2, height: r * 2))
        }

        // Soft circular wash that fades out with no hard edge — the look that
        // read best behind the arrow.
        if let wash = CGGradient(
            colorsSpace: CGColorSpaceCreateDeviceRGB(),
            colors: [
                lavender.withAlphaComponent(0.72).cgColor,
                lavender.withAlphaComponent(0.38).cgColor,
                purple.withAlphaComponent(0.14).cgColor,
                purple.withAlphaComponent(0).cgColor,
            ] as CFArray,
            locations: [0, 0.30, 0.65, 1]
        ) {
            let glowR: CGFloat = 34 * breathe
            let center = CGPoint(x: tip.x + 6, y: tip.y - 9)
            ctx.drawRadialGradient(
                wash,
                startCenter: center, startRadius: 0,
                endCenter: center, endRadius: glowR,
                options: []
            )
        }

        ctx.saveGState()
        ctx.translateBy(x: tip.x, y: tip.y)
        let travelX = abs(velocity.dx), travelY = abs(velocity.dy)
        let wobbleAmount = 0.18 * wobble * sin(wobblePhase)
        var popScale: CGFloat = 1
        if let pop { popScale = 1 + 0.22 * sin(pop * .pi * 2) * (1 - pop) }
        ctx.rotate(by: tilt)
        ctx.scaleBy(
            x: (1 + travelX / 200 - travelY / 400 + wobbleAmount) * popScale,
            y: (1 + travelY / 200 - travelX / 400 - wobbleAmount) * popScale
        )

        // Rounded arrowhead — soft enough not to read as a system pointer tip,
        // but not so pebble-like that the shape blurs.
        let corners = [
            NSPoint(x: 0, y: 0),
            NSPoint(x: 24, y: -11),
            NSPoint(x: 14.5, y: -16.5),
            NSPoint(x: 7, y: -28),
        ]
        let radius: CGFloat = 2.6
        let arrow = NSBezierPath()
        func midpoint(_ a: NSPoint, _ b: NSPoint) -> NSPoint {
            NSPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
        }
        arrow.move(to: midpoint(corners[corners.count - 1], corners[0]))
        for i in 0..<corners.count {
            arrow.appendArc(
                from: corners[i],
                to: corners[(i + 1) % corners.count],
                radius: radius
            )
        }
        arrow.close()
        arrow.lineJoinStyle = .round
        arrow.lineCapStyle = .round

        // Dark slate-purple fill — solid enough to read on light wallpapers,
        // with a slight tip→tail gradient so it isn't a flat hole.
        ctx.saveGState()
        arrow.addClip()
        let deep = NSColor(calibratedRed: 0.22, green: 0.20, blue: 0.38, alpha: 0.96)
        let body = NSColor(calibratedRed: 0.34, green: 0.32, blue: 0.52, alpha: 0.96)
        if let fill = NSGradient(starting: deep, ending: body) {
            fill.draw(in: arrow.bounds, angle: 40)
        }
        ctx.restoreGState()

        // White rim — mid weight between the thin hairline and the heavy outline.
        ctx.saveGState()
        ctx.setShadow(
            offset: .zero,
            blur: 6,
            color: lavender.withAlphaComponent(0.55).cgColor
        )
        arrow.lineWidth = 2.8
        NSColor(calibratedWhite: 1.0, alpha: 1).setStroke()
        arrow.stroke()
        ctx.restoreGState()

        arrow.lineWidth = 2.6
        NSColor(calibratedWhite: 0.99, alpha: 1).setStroke()
        arrow.stroke()

        ctx.restoreGState()
    }
}
