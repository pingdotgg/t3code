import Darwin
import Foundation

/// Lifecycle states emitted on `ServerProcess.states()`. `restartAttempt`
/// (0-based) is the number of restarts already attempted for the current
/// desired-running episode; it resets to 0 once a run reaches `.ready`.
public enum SidecarState: Sendable, Equatable {
    case idle
    case launching(restartAttempt: Int)
    case ready(pid: Int32)
    case crashed(reason: String, restartAttempt: Int)
    case stopped
}

/// Supervises exactly one t3 server child process, porting
/// `apps/desktop/src/backend/DesktopBackendManager.ts`'s lifecycle: spawn,
/// bootstrap delivery over stdin, readiness polling, crash-restart with
/// exponential backoff, and graceful shutdown.
///
/// One `ServerProcess` instance owns one child at a time. Callers drive it
/// with `start()`/`stop()` and observe `states()`.
public actor ServerProcess {
    private static let readinessPath = "/.well-known/t3/environment"
    private static let readinessTimeout: TimeInterval = 60
    private static let readinessPollInterval: TimeInterval = 0.1
    private static let terminateGrace: TimeInterval = 2
    private static let initialRestartDelay: TimeInterval = 0.5
    private static let maxRestartDelay: TimeInterval = 10

    private let config: SidecarConfig
    private let bootstrapToken: String
    private let fileManager: FileManager

    private var process: Process?
    private var currentRunID = UUID()
    private var desiredRunning = false
    private var restartAttempt = 0
    private var restartTask: Task<Void, Never>?
    /// App Nap suppression token held while the sidecar is desired-running.
    private var activityToken: NSObjectProtocol?
    private var currentState: SidecarState = .idle
    private var stateContinuations: [UUID: AsyncStream<SidecarState>.Continuation] = [:]
    /// Bumped by every `start()`/`stop()` entry. `stop()` captures its value
    /// on entry and re-checks it after each `await` before mutating terminal
    /// state (`process`, `.stopped`), so a `start()` that races in during
    /// `stop()`'s teardown wins instead of being silently clobbered.
    private var operationGeneration = 0

    public init(
        config: SidecarConfig,
        bootstrapToken: String,
        fileManager: FileManager = .default
    ) {
        self.config = config
        self.bootstrapToken = bootstrapToken
        self.fileManager = fileManager
    }

    /// A fresh subscription always immediately receives the current state,
    /// then every subsequent transition. Multiple subscribers are supported;
    /// each gets its own continuation.
    public func states() -> AsyncStream<SidecarState> {
        let id = UUID()
        let (stream, continuation) = AsyncStream.makeStream(of: SidecarState.self)
        continuation.onTermination = { [weak self] _ in
            Task { await self?.removeStateContinuation(id: id) }
        }
        stateContinuations[id] = continuation
        continuation.yield(currentState)
        return stream
    }

    private func removeStateContinuation(id: UUID) {
        stateContinuations.removeValue(forKey: id)
    }

    deinit {
        for continuation in stateContinuations.values {
            continuation.finish()
        }
    }

    public func snapshot() -> SidecarState {
        currentState
    }

    /// Starts the supervised child if it isn't already desired-running.
    /// Idempotent: calling `start()` again while already running is a no-op,
    /// mirroring the TS manager's `start` (which returns early when
    /// `Option.isSome(current.active)`).
    public func start() async {
        guard !desiredRunning else { return }
        desiredRunning = true
        restartAttempt = 0
        // App Nap / RunningBoard suspends the whole process coalition of a
        // Finder/`open`-launched app that looks idle — including the spawned
        // node child (observed as the sidecar sitting in `T` state, never
        // booting). Hold an activity assertion for the sidecar's lifetime
        // so the coalition stays runnable.
        if activityToken == nil {
            activityToken = ProcessInfo.processInfo.beginActivity(
                options: [.userInitiated, .automaticTerminationDisabled],
                reason: "t3 server sidecar running")
        }
        // Supersede any stop() currently unwinding through its await points
        // so its teardown no-ops instead of clobbering this run once it
        // resumes (see `operationGeneration` doc comment above).
        operationGeneration += 1
        await launch()
    }

    /// SIGTERM, then SIGKILL after a 2s grace period if the process hasn't
    /// exited on its own.
    public func stop() async {
        desiredRunning = false
        restartTask?.cancel()
        restartTask = nil
        if let token = activityToken {
            activityToken = nil
            ProcessInfo.processInfo.endActivity(token)
        }
        // Invalidate any in-flight readiness poll / termination callback
        // from the run being stopped so they no-op instead of racing a
        // subsequent start().
        currentRunID = UUID()
        operationGeneration += 1
        let myGeneration = operationGeneration

        guard let runningProcess = process, runningProcess.isRunning else {
            guard myGeneration == operationGeneration else { return }
            process = nil
            emit(.stopped)
            return
        }

        runningProcess.terminate()  // sends SIGTERM
        let exitedGracefully = await waitForExit(of: runningProcess, timeout: Self.terminateGrace)
        if !exitedGracefully {
            kill(runningProcess.processIdentifier, SIGKILL)
            _ = await waitForExit(of: runningProcess, timeout: Self.terminateGrace)
        }

        // If a start() raced in while we were awaiting the child's exit, it
        // will have bumped `operationGeneration` past what we captured; bail
        // out instead of nulling out / marking `.stopped` the new run it
        // just spun up.
        guard myGeneration == operationGeneration else { return }
        process = nil
        emit(.stopped)
    }

    // MARK: - Launch

    private func launch() async {
        let runID = UUID()
        currentRunID = runID
        emit(.launching(restartAttempt: restartAttempt))

        let envelope = BootstrapEnvelope(
            port: config.port,
            t3Home: config.baseDir,
            host: config.host,
            desktopBootstrapToken: bootstrapToken,
            noBrowser: config.noBrowser
        )

        let bootstrapLine: String
        do {
            bootstrapLine = try envelope.encodeLine()
        } catch {
            failLaunch(reason: "failed to encode bootstrap envelope: \(error)")
            return
        }

        let logHandles: (stdout: FileHandle, stderr: FileHandle)
        do {
            logHandles = try makeLogHandles()
        } catch {
            failLaunch(reason: "failed to open sidecar log files: \(error)")
            return
        }

        let childProcess = Process()
        childProcess.executableURL = URL(fileURLWithPath: config.nodePath)
        childProcess.arguments = [
            config.entryPath,
            "--mode", "desktop",
            "--bootstrap-fd", "0",
            "--port", String(config.port),
            "--host", config.host,
            "--base-dir", config.baseDir,
            "--no-browser",
        ]

        let stdinPipe = Pipe()
        childProcess.standardInput = stdinPipe
        childProcess.standardOutput = logHandles.stdout
        childProcess.standardError = logHandles.stderr

        childProcess.terminationHandler = { [weak self] terminated in
            let status = terminated.terminationStatus
            let uncaughtSignal = terminated.terminationReason == .uncaughtSignal
            Task { await self?.handleTermination(runID: runID, status: status, uncaughtSignal: uncaughtSignal) }
        }

        do {
            try childProcess.run()
        } catch {
            failLaunch(reason: "failed to spawn node at \(config.nodePath): \(error)")
            return
        }

        process = childProcess

        // Write the bootstrap envelope as one JSON line, then close stdin.
        // This mirrors the TS reference: the desktop backend pipes a
        // single-chunk `Stream` into the child's stdin sink with
        // `endOnDone: true` (the default in
        // NodeChildProcessSpawner's `resolveStdinOption`), so the writable
        // — and therefore the child's stdin — is ended as soon as that one
        // chunk has been written. The server only ever reads one line off
        // the bootstrap fd (`readBootstrapEnvelope` in
        // apps/server/src/bootstrap.ts), so closing stdin afterward matches
        // upstream behavior and cannot truncate the envelope.
        do {
            let data = Data((bootstrapLine + "\n").utf8)
            try stdinPipe.fileHandleForWriting.write(contentsOf: data)
        } catch {
            // The child may have already exited (e.g. immediate crash)
            // before we could write; the termination handler above will
            // observe the exit and drive the restart loop. Swallow here.
        }
        stdinPipe.fileHandleForWriting.closeFile()

        Task { await self.pollReadiness(runID: runID, pid: childProcess.processIdentifier) }
    }

    private func failLaunch(reason: String) {
        emit(.crashed(reason: reason, restartAttempt: restartAttempt))
        scheduleRestartIfNeeded(reason: reason)
    }

    // MARK: - Readiness

    private func pollReadiness(runID: UUID, pid: Int32) async {
        // A wildcard bind (0.0.0.0 / ::, used when LAN access for the mobile
        // app is enabled) is not a connectable address; probe via loopback.
        let probeHost =
            (config.host == "0.0.0.0" || config.host == "::" || config.host == "[::]")
            ? "127.0.0.1" : config.host
        guard let url = URL(string: "http://\(probeHost):\(config.port)\(Self.readinessPath)") else {
            return
        }
        let deadline = Date().addingTimeInterval(Self.readinessTimeout)

        while Date() < deadline {
            guard runID == currentRunID else { return }
            if await probeReady(url: url) {
                guard runID == currentRunID else { return }
                guard let process,
                    process.processIdentifier == pid,
                    process.isRunning
                else { return }
                restartAttempt = 0
                emit(.ready(pid: pid))
                return
            }
            try? await Task.sleep(nanoseconds: UInt64(Self.readinessPollInterval * 1_000_000_000))
        }

        guard runID == currentRunID else { return }
        let reason = "timed out waiting for readiness at \(url.absoluteString)"
        emit(.crashed(reason: reason, restartAttempt: restartAttempt))
        // A readiness timeout does not mean the child died — it is still
        // running and holding the port. Terminate it before restarting so
        // the next launch() doesn't leak/orphan it (Foundation does not
        // kill a child when its `Process` reference is dropped) and doesn't
        // fail to bind the still-occupied port.
        await terminateRun(runID: runID)
        scheduleRestartIfNeeded(reason: reason)
    }

    /// Terminates the child belonging to `runID` (if it is still the
    /// current run) and invalidates that run's id first, so the process's
    /// `terminationHandler` — which fires asynchronously off this kill —
    /// observes a stale `runID` and no-ops instead of driving its own
    /// duplicate crash/restart cycle.
    private func terminateRun(runID: UUID) async {
        guard runID == currentRunID, let runningProcess = process else { return }
        currentRunID = UUID()
        process = nil
        guard runningProcess.isRunning else { return }
        runningProcess.terminate()
        let exitedGracefully = await waitForExit(of: runningProcess, timeout: Self.terminateGrace)
        if !exitedGracefully {
            kill(runningProcess.processIdentifier, SIGKILL)
            _ = await waitForExit(of: runningProcess, timeout: Self.terminateGrace)
        }
    }

    private func probeReady(url: URL) async -> Bool {
        var request = URLRequest(url: url)
        request.timeoutInterval = 1
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { return false }
            return (200..<300).contains(http.statusCode)
        } catch {
            return false
        }
    }

    // MARK: - Termination + restart

    private func handleTermination(runID: UUID, status: Int32, uncaughtSignal: Bool) async {
        guard runID == currentRunID else { return }
        process = nil

        guard desiredRunning else {
            emit(.stopped)
            return
        }

        let reason = uncaughtSignal ? "terminated by signal" : "exited with code \(status)"
        emit(.crashed(reason: reason, restartAttempt: restartAttempt))
        scheduleRestartIfNeeded(reason: reason)
    }

    private func scheduleRestartIfNeeded(reason: String) {
        guard desiredRunning else { return }
        let delay = Self.backoffDelay(forAttempt: restartAttempt)
        restartAttempt += 1
        restartTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await self?.restartIfStillDesired()
        }
    }

    private func restartIfStillDesired() async {
        guard desiredRunning else { return }
        await launch()
    }

    /// Exponential backoff mirroring the TS reference's
    /// `Duration.min(Duration.times(INITIAL_RESTART_DELAY, 2 ** attempt), MAX_RESTART_DELAY)`:
    /// 500ms, 1s, 2s, 4s, 8s, capped at 10s from `attempt == 5` onward.
    public static func backoffDelay(forAttempt attempt: Int) -> TimeInterval {
        let multiplier = pow(2.0, Double(max(attempt, 0)))
        return min(initialRestartDelay * multiplier, maxRestartDelay)
    }

    // MARK: - Helpers

    private func waitForExit(of process: Process, timeout: TimeInterval) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning && Date() < deadline {
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        return !process.isRunning
    }

    private func emit(_ state: SidecarState) {
        currentState = state
        for continuation in stateContinuations.values {
            continuation.yield(state)
        }
    }

    /// Opens (rotating) stdout/stderr log files under
    /// `<baseDir>/logs/sidecar/`. Each new run rotates the previous file to
    /// `<name>.log.1` before truncating a fresh one, keeping one prior
    /// session's output alongside the current one.
    private func makeLogHandles() throws -> (stdout: FileHandle, stderr: FileHandle) {
        try fileManager.createDirectory(
            atPath: config.logDirectory, withIntermediateDirectories: true)

        let stdoutPath = (config.logDirectory as NSString).appendingPathComponent("stdout.log")
        let stderrPath = (config.logDirectory as NSString).appendingPathComponent("stderr.log")
        rotate(path: stdoutPath)
        rotate(path: stderrPath)

        fileManager.createFile(atPath: stdoutPath, contents: nil)
        fileManager.createFile(atPath: stderrPath, contents: nil)

        guard let stdout = FileHandle(forWritingAtPath: stdoutPath),
            let stderr = FileHandle(forWritingAtPath: stderrPath)
        else {
            throw ServerProcessError.logFileOpenFailed
        }
        return (stdout, stderr)
    }

    private func rotate(path: String) {
        guard fileManager.fileExists(atPath: path) else { return }
        let rotatedPath = path + ".1"
        try? fileManager.removeItem(atPath: rotatedPath)
        try? fileManager.moveItem(atPath: path, toPath: rotatedPath)
    }
}

public enum ServerProcessError: Error, Sendable {
    case logFileOpenFailed
}
