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
//     {"x": 400, "y": 260, "press": true}  move (no click ring)
//     {"hide": true}                    fade out until the next move
//
// Fade is driven by Computer Use tool activity (see noteDesktopTool*),
// not a wall-clock idle after the last move. The overlay stays up across
// mid-task pauses; it fades once desktop tools/call traffic stops.
//
// The look is the soft translucent bubble (lavender glow, rounded
// arrow, spring follow with tilt/squash, idle breathe) — never a
// system-style pointer. No click ring and no settle wobble.

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
    /// Last Quartz point we told the overlay to visit — used to time clicks
    /// so the real action waits for the spring animation to land.
    private var lastPoint: CGPoint?
    /// Bumped to cancel a pending post-task fade when another tools/call starts.
    private var taskHideGeneration: UInt64 = 0
    private var taskHideWork: DispatchWorkItem?

    /// Show the agent pointer at a screen point, starting the overlay if needed.
    ///
    /// Failures are deliberately silent toward the tool caller: the overlay is
    /// a courtesy, and a missing pointer must never turn a working click into a
    /// failed tool call. Launch problems still go to stderr so they are
    /// diagnosable without poisoning the MCP response.
    ///
    /// Blocks until the spring follow would have settled on `point`, so callers
    /// that click afterward land in sync with the visible pointer.
    func show(at point: CGPoint) {
        guard agentCursorEnabled else { return }
        moveAndWait(to: point, press: false)
    }

    /// Move the agent pointer to a screen point, waiting for the animation.
    func press(at point: CGPoint) {
        guard agentCursorEnabled else { return }
        moveAndWait(to: point, press: true)
    }

    /// Non-blocking hop for mid-drag visuals (must not sleep while a button is down).
    func glide(at point: CGPoint) {
        guard agentCursorEnabled else { return }
        moveNoWait(to: point)
    }

    func hide() {
        lock.lock()
        defer { lock.unlock() }
        taskHideGeneration += 1
        taskHideWork?.cancel()
        taskHideWork = nil
        lastPoint = nil
        guard connection != nil || listenerFD >= 0 else { return }
        sendLocked(["hide": true])
    }

    /// A Computer Use `tools/call` is starting — keep the pointer up.
    func noteDesktopToolStarted() {
        guard agentCursorEnabled else { return }
        lock.lock()
        taskHideGeneration += 1
        taskHideWork?.cancel()
        taskHideWork = nil
        lock.unlock()
    }

    /// A Computer Use `tools/call` finished. If nothing else starts soon, the
    /// task is done and the pointer should fade — not N seconds after the last
    /// pixel move while the agent is still working.
    func noteDesktopToolFinished() {
        guard agentCursorEnabled else { return }
        lock.lock()
        // Only schedule if the pointer was actually used for this task.
        guard lastPoint != nil else {
            lock.unlock()
            return
        }
        taskHideGeneration += 1
        let generation = taskHideGeneration
        taskHideWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.lock.lock()
            let shouldHide = self.taskHideGeneration == generation
            self.lock.unlock()
            if shouldHide { self.hide() }
        }
        taskHideWork = work
        let delay = Self.taskFadeGraceSeconds()
        lock.unlock()
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + delay, execute: work)
    }

    /// Brief grace so a follow-up tool in the same turn cancels before fade.
    /// Override with `T3_DESKTOP_AGENT_CURSOR_TASK_FADE_SECS`.
    private static func taskFadeGraceSeconds() -> TimeInterval {
        if let raw = ProcessInfo.processInfo.environment["T3_DESKTOP_AGENT_CURSOR_TASK_FADE_SECS"],
           let value = Double(raw.trimmingCharacters(in: .whitespacesAndNewlines)),
           value.isFinite, value >= 0, value < 3600
        {
            return value
        }
        // Long enough to absorb normal model latency between chained desktop
        // tools; short enough that the pointer does not linger after the turn.
        return 8.0
    }

    private func moveAndWait(to point: CGPoint, press: Bool) {
        guard Self.isRepresentableScreenPoint(point) else { return }
        let wait: useconds_t
        var needsStartupSlack = false
        lock.lock()
        wait = travelWaitMicros(to: point)
        ensureRunning()
        needsStartupSlack = connection == nil
        // If the overlay could not start, drop the event instead of queuing
        // forever and growing `pending` for the lifetime of the MCP server.
        if connection != nil || listenerFD >= 0 {
            var message: [String: Any] = ["x": Int(point.x), "y": Int(point.y)]
            if press { message["press"] = true }
            sendLocked(message)
            lastPoint = point
        }
        lock.unlock()

        var total = wait
        if needsStartupSlack { total += 220_000 }
        if total > 0 { usleep(total) }
    }

    private func moveNoWait(to point: CGPoint) {
        guard Self.isRepresentableScreenPoint(point) else { return }
        lock.lock()
        ensureRunning()
        if connection != nil || listenerFD >= 0 {
            sendLocked(["x": Int(point.x), "y": Int(point.y)])
            lastPoint = point
        }
        lock.unlock()
    }

    /// Overlay messages use `Int` coordinates — reject non-finite / out-of-range
    /// values so `Int(point.x)` cannot trap the MCP process.
    private static func isRepresentableScreenPoint(_ point: CGPoint) -> Bool {
        let x = Double(point.x)
        let y = Double(point.y)
        guard x.isFinite, y.isFinite else { return false }
        let max = Double(Int.max)
        let min = Double(Int.min)
        return x >= min && x <= max && y >= min && y <= max
    }

    /// Approximate flight time matching OverlayController's cubic path.
    private func travelWaitMicros(to point: CGPoint) -> useconds_t {
        guard let from = lastPoint else {
            return 100_000
        }
        let dist = hypot(point.x - from.x, point.y - from.y)
        if dist < 2 { return 60_000 }
        // Same duration formula as the overlay flight.
        let seconds = min(0.85, max(0.28, 0.20 + Double(dist) / 1100.0))
        return useconds_t((seconds + 0.04) * 1_000_000)
    }

    private func ensureRunning() {
        if connection != nil { return }
        if listenerFD >= 0 { return }

        guard let appURL = OverlayBundle.ensureApp() else {
            fputs("t3-desktop-mcp: agent cursor: could not materialise T3AgentCursor.app\n", stderr)
            pending.removeAll()
            return
        }

        // sockaddr_un.sun_path is only 104 bytes on macOS; NSTemporaryDirectory()
        // under /var/folders/... plus a UUID blows past that and bind() fails,
        // which is why the overlay never started from the MCP server.
        let path = "/tmp/t3ac-\(getpid()).sock"
        guard startListening(at: path) else {
            fputs("t3-desktop-mcp: agent cursor: could not listen on \(path)\n", stderr)
            pending.removeAll()
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

        // If nothing connects, tear down the listener so later show/press retries
        // startup instead of queuing forever into a dead socket.
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 5.0) { [weak self] in
            guard let self else { return }
            self.lock.lock()
            defer { self.lock.unlock() }
            if self.connection == nil, self.socketPath == path {
                fputs("t3-desktop-mcp: agent cursor: overlay never connected; resetting\n", stderr)
                self.tearDownLocked()
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
        } else {
            // Compare size + contents — equal mtimes after a rebuild must not
            // leave a stale overlay binary in place.
            let srcData = try Data(contentsOf: executable)
            let dstData = (try? Data(contentsOf: dest)) ?? Data()
            needsCopy = srcData != dstData
        }
        guard needsCopy else { return }
        try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
        // Unique temp name so concurrent MCP sessions cannot clobber each other.
        let temp = dest.deletingLastPathComponent()
            .appendingPathComponent(".\(overlayExecutableName).\(getpid()).\(UUID().uuidString).new")
        defer { try? fm.removeItem(at: temp) }
        try fm.copyItem(at: executable, to: temp)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: temp.path)
        // Atomic replace: overwrite dest in place via replaceItem when possible.
        if fm.fileExists(atPath: dest.path) {
            _ = try fm.replaceItemAt(dest, withItemAt: temp)
        } else {
            try fm.moveItem(at: temp, to: dest)
        }
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

    /// Generous panel so the glow, squash and travel lean have room.
    private let side: CGFloat = 112
    /// Distance from the panel's top-left corner to the cursor's hot point.
    fileprivate static let hotspot: CGFloat = 56

    /// Plane-style cubic flight in Quartz screen coordinates.
    /// Tip follows path tangent the whole way; path flares upright into the
    /// target so reorientation happens on approach — not after landing.
    private var current: CGPoint?
    private var target: CGPoint = .zero
    private var velocity: CGVector = .zero
    private var pathFrom: CGPoint = .zero
    private var pathC1: CGPoint = .zero
    private var pathC2: CGPoint = .zero
    private var pathTo: CGPoint = .zero
    private var pathElapsed: CFTimeInterval = 0
    private var pathDuration: CFTimeInterval = 0
    private var pathActive = false
    private var arcSign: CGFloat = 1
    private var lastTickAt: CFTimeInterval?
    /// Bumped on each fadeOut / begin so a stale fade completion cannot orderOut
    /// a pointer that already reappeared.
    private var fadeGeneration: UInt64 = 0

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

    private func begin(_ point: CGPoint, popping _: Bool) {
        let panel = ensurePanel()
        target = point

        let fresh = current == nil || !panel.isVisible || panel.alphaValue < 0.05
        if fresh {
            fadeGeneration &+= 1
            current = point
            velocity = .zero
            pathActive = false
            view?.tilt = 0
            place(point)
            // Fade in — never pop to full opacity.
            panel.alphaValue = 0
            panel.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup({ ctx in
                ctx.duration = 0.50
                ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
                panel.animator().alphaValue = 1
            })
            startAnimating()
            return
        }

        // Cancel any in-flight fade-out / keep fully visible while moving.
        fadeGeneration &+= 1
        panel.alphaValue = 1
        let from = current ?? point
        let dx = point.x - from.x
        let dy = point.y - from.y
        let dist = hypot(dx, dy)
        if dist < 3 {
            current = point
            velocity = .zero
            pathActive = false
            view?.tilt = 0
            place(point)
            startAnimating()
            return
        }

        // Gentle cubic: leave along current facing (or chord), slight bank,
        // flare upright into the click. Handles stay modest so it never
        // teleports around the screen.
        arcSign *= -1
        let handle = min(72, max(22, dist * 0.18))
        let nx = -dy / dist
        let ny = dx / dist

        let startDir: CGVector
        if let view, abs(view.tilt) > 0.08 {
            let ang = -view.tilt
            startDir = CGVector(dx: sin(ang), dy: -cos(ang))
        } else {
            startDir = CGVector(dx: dx / dist, dy: dy / dist)
        }

        pathFrom = from
        pathTo = point
        let depart = min(handle, dist * 0.28)
        pathC1 = CGPoint(
            x: from.x + startDir.dx * depart + nx * min(36, dist * 0.10) * arcSign,
            y: from.y + startDir.dy * depart + ny * min(36, dist * 0.10) * arcSign
        )
        // Approach from "below" (Quartz Y-down) so final tangent is screen-up
        // → tip already upright as it arrives.
        let approach = min(handle * 0.85, max(20, dist * 0.16))
        pathC2 = CGPoint(x: point.x, y: point.y + approach)

        pathDuration = min(0.85, max(0.28, 0.20 + Double(dist) / 1100.0))
        pathElapsed = 0
        pathActive = true
        velocity = .zero
        lastTickAt = nil
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

        let now = CACurrentMediaTime()
        let dt = min(1.0 / 30.0, max(1.0 / 120.0, lastTickAt.map { now - $0 } ?? (1.0 / 60.0)))
        lastTickAt = now

        if pathActive, var cur = current {
            pathElapsed += dt
            let u = min(1.0, pathElapsed / max(0.001, pathDuration))
            // Ease-in-out along the flight path.
            let t = u * u * (3 - 2 * u)
            let pos = Self.cubicBezier(pathFrom, pathC1, pathC2, pathTo, CGFloat(t))
            let tan = Self.cubicBezierTangent(pathFrom, pathC1, pathC2, pathTo, CGFloat(t))
            velocity = CGVector(
                dx: (pos.x - cur.x) / CGFloat(dt),
                dy: (pos.y - cur.y) / CGFloat(dt)
            )
            cur = pos
            current = cur
            view.velocity = velocity

            // Tip tracks path tangent continuously — the turn into upright is
            // the last part of the curve, not a settle spin after arrival.
            let tanLen = hypot(tan.dx, tan.dy)
            if tanLen > 0.001 {
                let desired = -atan2(tan.dx, -tan.dy)
                var delta = desired - view.tilt
                while delta > .pi { delta -= 2 * .pi }
                while delta < -.pi { delta += 2 * .pi }
                // Slight lag early; tighten on final flare so tip matches path.
                let follow = min(1, 0.16 + CGFloat(t) * 0.55 + CGFloat(dt) * 7)
                view.tilt += delta * follow
            }

            if u >= 1 {
                current = pathTo
                velocity = .zero
                view.velocity = .zero
                view.tilt = 0
                pathActive = false
            }
            busy = true
            place(current ?? pathTo)
        }

        if panel?.isVisible == true, (panel?.alphaValue ?? 0) > 0.05 {
            view.phase += 0.08
            busy = true
        }
        view.needsDisplay = true

        if !busy {
            animation?.invalidate()
            animation = nil
            lastTickAt = nil
        }
    }

    private static func cubicBezier(
        _ p0: CGPoint, _ p1: CGPoint, _ p2: CGPoint, _ p3: CGPoint, _ t: CGFloat
    ) -> CGPoint {
        let o = 1 - t
        let o2 = o * o
        let t2 = t * t
        return CGPoint(
            x: o2 * o * p0.x + 3 * o2 * t * p1.x + 3 * o * t2 * p2.x + t2 * t * p3.x,
            y: o2 * o * p0.y + 3 * o2 * t * p1.y + 3 * o * t2 * p2.y + t2 * t * p3.y
        )
    }

    private static func cubicBezierTangent(
        _ p0: CGPoint, _ p1: CGPoint, _ p2: CGPoint, _ p3: CGPoint, _ t: CGFloat
    ) -> CGVector {
        let o = 1 - t
        return CGVector(
            dx: 3 * o * o * (p1.x - p0.x) + 6 * o * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x),
            dy: 3 * o * o * (p1.y - p0.y) + 6 * o * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y)
        )
    }

    private func place(_ point: CGPoint) {
        guard let panel else { return }
        let primary =
            NSScreen.screens.first(where: { $0.frame.origin == .zero })
            ?? NSScreen.main
            ?? NSScreen.screens.first
        guard let primary else { return }
        let flippedY = primary.frame.maxY - point.y
        panel.setFrameOrigin(NSPoint(
            x: point.x - OverlayController.hotspot,
            y: flippedY - side + OverlayController.hotspot
        ))
        panel.orderFrontRegardless()
    }

    private func fadeOut() {
        guard let panel, panel.isVisible else { return }
        pathActive = false
        fadeGeneration &+= 1
        let generation = fadeGeneration
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.35
            panel.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            guard let self else { return }
            // Ignore completions from a fade that was superseded by a new move.
            guard generation == self.fadeGeneration else { return }
            if panel.alphaValue < 0.05 {
                panel.orderOut(nil)
                self.animation?.invalidate()
                self.animation = nil
            }
        })
    }
}

/// Soft translucent bubble: lavender glow, rounded arrow, path heading,
/// idle breathe. No click ring.
private final class BubbleView: NSView {
    var phase: CGFloat = 0
    /// Unused for drawing now (no squash); kept so motion code can still assign it.
    var velocity: CGVector = .zero
    /// Path heading in radians (2D spin only); upright (0) when landed.
    var tilt: CGFloat = 0

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let tip = CGPoint(x: OverlayController.hotspot, y: bounds.maxY - OverlayController.hotspot)

        let lavender = NSColor(calibratedRed: 0.76, green: 0.72, blue: 0.99, alpha: 1)
        let purple = NSColor(calibratedRed: 0.58, green: 0.52, blue: 0.94, alpha: 1)
        let breathe = 1 + 0.03 * sin(phase)

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
        // Pure 2D: rotate in the plane only — never squash/stretch (reads as 3D).
        ctx.rotate(by: tilt)

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

        ctx.saveGState()
        arrow.addClip()
        let deep = NSColor(calibratedRed: 0.22, green: 0.20, blue: 0.38, alpha: 0.96)
        let body = NSColor(calibratedRed: 0.34, green: 0.32, blue: 0.52, alpha: 0.96)
        if let fill = NSGradient(starting: deep, ending: body) {
            fill.draw(in: arrow.bounds, angle: 40)
        }
        ctx.restoreGState()

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
