// LiveIntegrationTests.swift
// Live, protocol-level end-to-end check of the full stack: a real `node
// dist/bin.mjs` sidecar process, the real desktop-managed-local HTTP auth
// handshake, a real WebSocket RPC connection, real subscriptions, and a real
// dispatchCommand write path (project + thread creation) persisted to SQLite.
//
// Gated behind `SERGECODE_LIVE_E2E=1` (opt-in): it spawns a real child
// process and hits real HTTP/WS endpoints, which is too slow/heavy for the
// default `swift test` run.
//
// Why this file doesn't `import SidecarKit`: this test target (T3KitTests)
// only depends on T3Kit in Package.swift, and apps/mac/CLAUDE.md hard-rules
// against editing Package.swift ("target layout is fixed") without
// coordinating. Rather than widen that target's dependencies, the handful of
// SidecarKit responsibilities this test needs — bootstrap envelope encoding,
// spawning the node child, stdin handoff, readiness polling, graceful
// shutdown, free-port selection — are reproduced here in miniature,
// deliberately mirroring SidecarKit.ServerProcess / BootstrapEnvelope /
// NodeRuntimeLocator / SidecarConfig (which already have their own unit
// coverage in Tests/SidecarKitTests). This file's job is to validate the
// *wire protocol* end-to-end (T3Kit's AuthClient/RpcConnection/T3Client
// against a live server), not to re-test SidecarKit's supervisor logic.

import Foundation
import Testing

@testable import T3Kit

#if canImport(Darwin)
    import Darwin
#endif

// MARK: - Errors

private enum LiveE2EError: Error, CustomStringConvertible {
    case setupFailed(String)
    case timedOut(String)
    case streamEnded(String)

    var description: String {
        switch self {
        case .setupFailed(let message): return "setup failed: \(message)"
        case .timedOut(let context): return "timed out waiting for: \(context)"
        case .streamEnded(let context): return "stream ended before: \(context)"
        }
    }
}

// MARK: - Miniature sidecar launcher (see file header for why this is
// duplicated here instead of importing SidecarKit)

/// `DesktopBackendBootstrap` mirror (packages/contracts/src/desktopBootstrap.ts),
/// matching SidecarKit.BootstrapEnvelope's wire shape.
private struct TestBootstrapEnvelope: Encodable {
    var mode = "desktop"
    var noBrowser = true
    var port: Int
    var t3Home: String?
    var host: String
    var desktopBootstrapToken: String
    var tailscaleServeEnabled = false
    var tailscaleServePort = 443
    var otlpTracesUrl: String?
    var otlpMetricsUrl: String?
}

private func makeBootstrapToken() -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    bytes.withUnsafeMutableBytes { buffer in
        arc4random_buf(buffer.baseAddress, buffer.count)
    }
    return Data(bytes).base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

/// Binds to port 0 on `host` to let the kernel assign a free loopback port,
/// reads it back, then releases the socket (mirrors SidecarKit.FreePortPicker;
/// same inherent TOCTOU tradeoff, acceptable for a local test run).
private func pickFreePort(host: String = "127.0.0.1") throws -> Int {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { throw LiveE2EError.setupFailed("socket() failed") }
    defer { close(fd) }

    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = 0
    addr.sin_addr.s_addr = inet_addr(host)

    let bindResult = withUnsafePointer(to: &addr) { pointer -> Int32 in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
            bind(fd, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
    }
    guard bindResult == 0 else { throw LiveE2EError.setupFailed("bind() failed") }

    var boundAddr = sockaddr_in()
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    let getsocknameResult = withUnsafeMutablePointer(to: &boundAddr) { pointer -> Int32 in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
            getsockname(fd, sockaddrPointer, &length)
        }
    }
    guard getsocknameResult == 0 else { throw LiveE2EError.setupFailed("getsockname() failed") }

    return Int(UInt16(bigEndian: boundAddr.sin_port))
}

/// Default server entry: `apps/server/dist/bin.mjs`, derived from this test
/// file's own location (`.../apps/mac/Tests/T3KitTests/LiveIntegrationTests.swift`
/// -> repo root -> `apps/server/dist/bin.mjs`) rather than a hardcoded
/// machine/user-specific absolute path, so the fallback is portable across
/// clones of this repo. `$SERGECODE_SERVER_ENTRY` still overrides it.
private func defaultServerEntryPath() -> String {
    let thisFile = URL(fileURLWithPath: #filePath)
    // .../apps/mac/Tests/T3KitTests/LiveIntegrationTests.swift -> apps/mac
    let appsMacDir =
        thisFile
        .deletingLastPathComponent()  // T3KitTests
        .deletingLastPathComponent()  // Tests
        .deletingLastPathComponent()  // apps/mac
    return
        appsMacDir
        .appendingPathComponent("../server/dist/bin.mjs")
        .standardizedFileURL
        .path
}

/// Scratch root for the e2e test's throwaway home dir + git repo. Defaults to
/// a directory under the system temp dir (not a hardcoded session-specific
/// path) so the test is portable across machines/sessions/CI;
/// `$SERGECODE_LIVE_E2E_SCRATCH` overrides it.
private func defaultScratchRoot() -> String {
    if let override = ProcessInfo.processInfo.environment["SERGECODE_LIVE_E2E_SCRATCH"],
        !override.isEmpty
    {
        return override
    }
    return NSTemporaryDirectory() + "sergecode-live-e2e"
}

/// Priority order mirrors SidecarKit.NodeRuntimeLocator: `$SERGECODE_NODE`
/// override, login-shell PATH probe, then common install paths.
private func locateNode() -> String? {
    let environment = ProcessInfo.processInfo.environment
    var candidates: [String] = []
    if let override = environment["SERGECODE_NODE"], !override.isEmpty {
        candidates.append(override)
    }
    if let shellNode = probeLoginShellNodePath() {
        candidates.append(shellNode)
    }
    let home = environment["HOME"] ?? NSHomeDirectory()
    candidates.append(contentsOf: [
        "\(home)/.local/bin/node",
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
    ])
    return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
}

private func probeLoginShellNodePath() -> String? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/zsh")
    process.arguments = ["-ilc", "command -v node"]
    let stdout = Pipe()
    process.standardOutput = stdout
    process.standardError = Pipe()
    do {
        try process.run()
    } catch {
        return nil
    }
    process.waitUntilExit()
    guard process.terminationStatus == 0 else { return nil }
    let data = stdout.fileHandleForReading.readDataToEndOfFile()
    guard let text = String(data: data, encoding: .utf8) else { return nil }
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
}

/// Spawns `node <entryPath> --mode desktop --bootstrap-fd 0 ...`, writes the
/// bootstrap envelope as one JSON line to stdin, then closes stdin — mirroring
/// SidecarKit.ServerProcess.launch(). Stdout/stderr go to `logDir` for
/// post-mortem debugging.
private func spawnServer(
    nodePath: String, entryPath: String, port: Int, host: String, baseDir: String,
    bootstrapToken: String, logDir: String
) throws -> Process {
    let envelope = TestBootstrapEnvelope(
        port: port, t3Home: baseDir, host: host, desktopBootstrapToken: bootstrapToken)
    let envelopeData = try JSONEncoder().encode(envelope)
    guard let envelopeJSON = String(data: envelopeData, encoding: .utf8) else {
        throw LiveE2EError.setupFailed("failed to encode bootstrap envelope as UTF-8")
    }

    try FileManager.default.createDirectory(atPath: logDir, withIntermediateDirectories: true)
    let stdoutPath = (logDir as NSString).appendingPathComponent("stdout.log")
    let stderrPath = (logDir as NSString).appendingPathComponent("stderr.log")
    FileManager.default.createFile(atPath: stdoutPath, contents: nil)
    FileManager.default.createFile(atPath: stderrPath, contents: nil)
    guard let stdout = FileHandle(forWritingAtPath: stdoutPath),
        let stderr = FileHandle(forWritingAtPath: stderrPath)
    else {
        throw LiveE2EError.setupFailed("could not open sidecar log files under \(logDir)")
    }

    let process = Process()
    process.executableURL = URL(fileURLWithPath: nodePath)
    process.arguments = [
        entryPath,
        "--mode", "desktop",
        "--bootstrap-fd", "0",
        "--port", String(port),
        "--host", host,
        "--base-dir", baseDir,
        "--no-browser",
    ]
    let stdinPipe = Pipe()
    process.standardInput = stdinPipe
    process.standardOutput = stdout
    process.standardError = stderr

    try process.run()
    // Best-effort: if the child already exited, this write throws and is
    // swallowed — readiness polling below will simply time out and the test
    // fails with the sidecar's own stdout/stderr as context.
    try? stdinPipe.fileHandleForWriting.write(contentsOf: Data((envelopeJSON + "\n").utf8))
    stdinPipe.fileHandleForWriting.closeFile()

    return process
}

/// Polls `GET /.well-known/t3/environment` every 100ms up to `timeout`
/// seconds, mirroring SidecarKit.ServerProcess.pollReadiness.
private func waitForReadiness(host: String, port: Int, timeout: TimeInterval = 60) async -> Bool {
    guard let url = URL(string: "http://\(host):\(port)/.well-known/t3/environment") else {
        return false
    }
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        var request = URLRequest(url: url)
        request.timeoutInterval = 1
        if let (_, response) = try? await URLSession.shared.data(for: request),
            let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode)
        {
            return true
        }
        try? await Task.sleep(nanoseconds: 100_000_000)
    }
    return false
}

/// SIGTERM, 2s grace, then SIGKILL — mirrors SidecarKit.ServerProcess.stop.
private func terminateProcess(_ process: Process) async {
    guard process.isRunning else { return }
    process.terminate()
    let deadline = Date().addingTimeInterval(2)
    while process.isRunning && Date() < deadline {
        try? await Task.sleep(nanoseconds: 50_000_000)
    }
    if process.isRunning {
        kill(process.processIdentifier, SIGKILL)
    }
}

private func readLogTail(logDir: String, maxBytes: Int = 4000) -> String {
    var combined = ""
    for name in ["stdout.log", "stderr.log"] {
        let path = (logDir as NSString).appendingPathComponent(name)
        guard let data = FileManager.default.contents(atPath: path) else { continue }
        let tail = data.suffix(maxBytes)
        let text = String(data: tail, encoding: .utf8) ?? "<non-utf8 log data>"
        combined += "--- \(name) (last \(tail.count) bytes) ---\n\(text)\n"
    }
    return combined
}

// MARK: - git helper (throwaway repo for the created project)

@discardableResult
private func runGit(_ arguments: [String], cwd: String) throws -> String {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["git"] + arguments
    process.currentDirectoryURL = URL(fileURLWithPath: cwd)
    let stdout = Pipe()
    let stderr = Pipe()
    process.standardOutput = stdout
    process.standardError = stderr
    try process.run()
    process.waitUntilExit()
    let outData = stdout.fileHandleForReading.readDataToEndOfFile()
    let errData = stderr.fileHandleForReading.readDataToEndOfFile()
    guard process.terminationStatus == 0 else {
        let out = String(data: outData, encoding: .utf8) ?? ""
        let err = String(data: errData, encoding: .utf8) ?? ""
        throw LiveE2EError.setupFailed("git \(arguments.joined(separator: " ")) failed: \(out)\(err)")
    }
    return String(data: outData, encoding: .utf8) ?? ""
}

// MARK: - Stream-with-timeout helper
//
// AsyncThrowingStream supports only a single logical consumer, so a long-lived
// subscription (e.g. subscribeShell) is wrapped in this reference-typed
// cursor and awaited multiple times (once per expected event) rather than
// re-iterated from scratch. `@unchecked Sendable` is safe here because the
// test only ever has one in-flight call to `next()` at a time (the racing
// timeout task never touches the iterator).
private final class StreamCursor<T: Sendable>: @unchecked Sendable {
    private var iterator: AsyncThrowingStream<T, Error>.AsyncIterator
    init(_ stream: AsyncThrowingStream<T, Error>) {
        iterator = stream.makeAsyncIterator()
    }
    func next() async throws -> T? {
        try await iterator.next()
    }
}

/// Awaits the next stream element matching `predicate`, racing a timeout.
private func waitForNext<T: Sendable>(
    _ cursor: StreamCursor<T>, context: String, timeout: Duration = .seconds(10),
    where predicate: @escaping @Sendable (T) -> Bool
) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask {
            while true {
                guard let item = try await cursor.next() else {
                    throw LiveE2EError.streamEnded(context)
                }
                if predicate(item) { return item }
            }
        }
        group.addTask {
            try await Task.sleep(for: timeout)
            throw LiveE2EError.timedOut(context)
        }
        defer { group.cancelAll() }
        guard let result = try await group.next() else {
            throw LiveE2EError.timedOut(context)
        }
        return result
    }
}

// MARK: - The test

@Test(.enabled(if: ProcessInfo.processInfo.environment["SERGECODE_LIVE_E2E"] == "1"))
func liveEndToEndProtocolFlow() async throws {
    let scratchRoot = defaultScratchRoot()
    let baseDir = scratchRoot + "/e2e-home"
    let repoDir = scratchRoot + "/e2e-repo"
    let fileManager = FileManager.default

    try? fileManager.removeItem(atPath: baseDir)
    try? fileManager.removeItem(atPath: repoDir)
    try fileManager.createDirectory(atPath: baseDir, withIntermediateDirectories: true)
    try fileManager.createDirectory(atPath: repoDir, withIntermediateDirectories: true)

    // A throwaway git repo for the project the test creates.
    try runGit(["init"], cwd: repoDir)
    try runGit(["config", "user.email", "e2e@example.test"], cwd: repoDir)
    try runGit(["config", "user.name", "E2E Test"], cwd: repoDir)
    try "hello\n".write(toFile: repoDir + "/README.md", atomically: true, encoding: .utf8)
    try runGit(["add", "-A"], cwd: repoDir)
    try runGit(["commit", "-m", "initial commit"], cwd: repoDir)

    guard let nodePath = locateNode() else {
        Issue.record("Could not locate a node binary (checked $SERGECODE_NODE, login-shell PATH, common install paths).")
        return
    }
    let entryPath =
        ProcessInfo.processInfo.environment["SERGECODE_SERVER_ENTRY"]
        ?? defaultServerEntryPath()
    guard fileManager.isExecutableFile(atPath: entryPath) else {
        Issue.record("Server entry point not found/executable at \(entryPath).")
        return
    }

    let host = "127.0.0.1"
    let port = try pickFreePort(host: host)
    let bootstrapToken = makeBootstrapToken()
    let logDir = baseDir + "/logs/sidecar"

    let process = try spawnServer(
        nodePath: nodePath, entryPath: entryPath, port: port, host: host, baseDir: baseDir,
        bootstrapToken: bootstrapToken, logDir: logDir)

    let ready = await waitForReadiness(host: host, port: port)
    guard ready else {
        await terminateProcess(process)
        Issue.record(
            "Sidecar did not become ready within 60s.\n\(readLogTail(logDir: logDir))")
        return
    }

    var connection: RpcConnection?
    do {
        let kitConfig = T3KitConfig(host: host, port: port, desktopBootstrapToken: bootstrapToken)
        let authClient = AuthClient(config: kitConfig.authConfig)

        // Full auth chain: bootstrap token -> access token -> wsTicket -> socket URL.
        let socketURL = try await authClient.makeSocketURL()
        #expect(socketURL.absoluteString.contains("wsTicket="))

        let conn = RpcConnection(url: socketURL)
        connection = conn
        try await conn.connect()
        let client = T3Client(transport: conn)

        // server.getConfig round-trip.
        let config = try await client.getConfig()
        #expect(config.auth.policy == .desktopManagedLocal)
        #expect(config.environment.platform.os == .darwin)

        // Subscribe to the project/thread shell before writing, so the
        // snapshot-then-live-tail events for our writes are observed.
        let shellStream = await client.subscribeShell()
        let shellCursor = StreamCursor(shellStream)
        let firstItem = try await waitForNext(shellCursor, context: "initial shell snapshot") { _ in
            true
        }
        guard case .snapshot = firstItem else {
            throw LiveE2EError.setupFailed(
                "expected the first subscribeShell item to be a snapshot, got \(firstItem)")
        }

        // dispatchCommand: project.create, pointed at the throwaway git repo.
        let projectId = "e2e-project-\(UUID().uuidString.prefix(8))"
        _ = try await client.createProject(
            projectId: projectId, title: "E2E Project", workspaceRoot: repoDir,
            createWorkspaceRootIfMissing: false)

        let projectEvent = try await waitForNext(
            shellCursor, context: "project-upserted event for \(projectId)"
        ) { item in
            if case .event(.projectUpserted(_, let project)) = item, project.id == projectId {
                return true
            }
            return false
        }
        if case .event(.projectUpserted(_, let project)) = projectEvent {
            #expect(project.workspaceRoot == repoDir)
        }

        // dispatchCommand: thread.create with provider claude. Prefer a real
        // configured claude-driver instance/model from getConfig; fall back to
        // a plausible instanceId/model if this machine has none configured
        // (dispatchCommand does not appear to validate ModelSelection against
        // the live provider table — only its own schema shape).
        let claudeProvider = config.providers.first { $0.driver.lowercased().contains("claude") }
        let claudeModel = claudeProvider?.models.first?.slug
        let modelSelection = ModelSelection(
            instanceId: claudeProvider?.instanceId ?? "claude-code",
            model: (claudeModel?.isEmpty == false) ? claudeModel! : "claude-sonnet-4-5")

        let threadId = "e2e-thread-\(UUID().uuidString.prefix(8))"
        _ = try await client.createThread(
            threadId: threadId, projectId: projectId, title: "E2E Thread",
            modelSelection: modelSelection, runtimeMode: .fullAccess)

        let threadEvent = try await waitForNext(
            shellCursor, context: "thread-upserted event for \(threadId)"
        ) { item in
            if case .event(.threadUpserted(_, let thread)) = item, thread.id == threadId {
                return true
            }
            return false
        }
        if case .event(.threadUpserted(_, let thread)) = threadEvent {
            #expect(thread.projectId == projectId)
            #expect(thread.modelSelection.instanceId == modelSelection.instanceId)
        }

        // Clean shutdown: closing the socket tears down all of this
        // connection's server-side subscriptions (wire-protocol.md §2.4), so
        // there is no separate Interrupt needed for the shell subscription.
        await conn.disconnect(reason: "test complete")
        connection = nil
    } catch {
        if let connection {
            await connection.disconnect(reason: "test failed")
        }
        await terminateProcess(process)
        throw error
    }

    await terminateProcess(process)
}

/// Live check of the first-turn worktree bootstrap that LiveBackend now sends
/// when defaultThreadEnvMode is worktree: `thread.turn.start` with
/// `bootstrap.prepareWorktree` must create a real `git worktree` on the
/// requested branch and flow the worktreePath/branch back through the shell
/// subscription via `thread.meta.update`.
@Test(.enabled(if: ProcessInfo.processInfo.environment["SERGECODE_LIVE_E2E"] == "1"))
func liveWorktreeBootstrapFlow() async throws {
    let scratchRoot = defaultScratchRoot()
    let baseDir = scratchRoot + "/e2e-worktree-home"
    let repoDir = scratchRoot + "/e2e-worktree-repo"
    let fileManager = FileManager.default

    try? fileManager.removeItem(atPath: baseDir)
    try? fileManager.removeItem(atPath: repoDir)
    try fileManager.createDirectory(atPath: baseDir, withIntermediateDirectories: true)
    try fileManager.createDirectory(atPath: repoDir, withIntermediateDirectories: true)

    try runGit(["init"], cwd: repoDir)
    try runGit(["config", "user.email", "e2e@example.test"], cwd: repoDir)
    try runGit(["config", "user.name", "E2E Test"], cwd: repoDir)
    try "hello\n".write(toFile: repoDir + "/README.md", atomically: true, encoding: .utf8)
    try runGit(["add", "-A"], cwd: repoDir)
    try runGit(["commit", "-m", "initial commit"], cwd: repoDir)
    let baseBranch = try runGit(["branch", "--show-current"], cwd: repoDir)
        .trimmingCharacters(in: .whitespacesAndNewlines)

    guard let nodePath = locateNode() else {
        Issue.record("Could not locate a node binary (checked $SERGECODE_NODE, login-shell PATH, common install paths).")
        return
    }
    let entryPath =
        ProcessInfo.processInfo.environment["SERGECODE_SERVER_ENTRY"]
        ?? defaultServerEntryPath()
    guard fileManager.isExecutableFile(atPath: entryPath) else {
        Issue.record("Server entry point not found/executable at \(entryPath).")
        return
    }

    let host = "127.0.0.1"
    let port = try pickFreePort(host: host)
    let bootstrapToken = makeBootstrapToken()
    let logDir = baseDir + "/logs/sidecar"

    let process = try spawnServer(
        nodePath: nodePath, entryPath: entryPath, port: port, host: host, baseDir: baseDir,
        bootstrapToken: bootstrapToken, logDir: logDir)

    let ready = await waitForReadiness(host: host, port: port)
    guard ready else {
        await terminateProcess(process)
        Issue.record(
            "Sidecar did not become ready within 60s.\n\(readLogTail(logDir: logDir))")
        return
    }

    var connection: RpcConnection?
    do {
        let kitConfig = T3KitConfig(host: host, port: port, desktopBootstrapToken: bootstrapToken)
        let authClient = AuthClient(config: kitConfig.authConfig)
        let socketURL = try await authClient.makeSocketURL()
        let conn = RpcConnection(url: socketURL)
        connection = conn
        try await conn.connect()
        let client = T3Client(transport: conn)

        let config = try await client.getConfig()
        let shellStream = await client.subscribeShell()
        let shellCursor = StreamCursor(shellStream)
        _ = try await waitForNext(shellCursor, context: "initial shell snapshot") { _ in true }

        let projectId = "e2e-wt-project-\(UUID().uuidString.prefix(8))"
        _ = try await client.createProject(
            projectId: projectId, title: "E2E Worktree Project", workspaceRoot: repoDir,
            createWorkspaceRootIfMissing: false)
        _ = try await waitForNext(
            shellCursor, context: "project-upserted event for \(projectId)"
        ) { item in
            if case .event(.projectUpserted(_, let project)) = item, project.id == projectId {
                return true
            }
            return false
        }

        let claudeProvider = config.providers.first { $0.driver.lowercased().contains("claude") }
        let claudeModel = claudeProvider?.models.first?.slug
        let modelSelection = ModelSelection(
            instanceId: claudeProvider?.instanceId ?? "claude-code",
            model: (claudeModel?.isEmpty == false) ? claudeModel! : "claude-sonnet-4-5")

        let threadId = "e2e-wt-thread-\(UUID().uuidString.prefix(8))"
        _ = try await client.createThread(
            threadId: threadId, projectId: projectId, title: "E2E Worktree Thread",
            modelSelection: modelSelection, runtimeMode: .fullAccess)
        _ = try await waitForNext(
            shellCursor, context: "thread-upserted event for \(threadId)"
        ) { item in
            if case .event(.threadUpserted(_, let thread)) = item, thread.id == threadId {
                return true
            }
            return false
        }

        // The exact shape LiveBackend sends on a worktree thread's first
        // turn. The turn itself may fail (no usable provider on CI); the
        // worktree prep + thread.meta.update run before the turn dispatch,
        // so the meta event must arrive regardless.
        let worktreeBranch = "t3code/e2e0000a"
        _ = try? await client.startTurn(
            threadId: threadId, text: "worktree bootstrap E2E",
            bootstrap: ThreadTurnStartBootstrap(
                prepareWorktree: ThreadTurnStartBootstrapPrepareWorktree(
                    projectCwd: repoDir, baseBranch: baseBranch, branch: worktreeBranch),
                runSetupScript: false))

        let metaEvent = try await waitForNext(
            shellCursor, context: "worktree meta update for \(threadId)",
            timeout: .seconds(30)
        ) { item in
            if case .event(.threadUpserted(_, let thread)) = item, thread.id == threadId,
                thread.worktreePath != nil
            {
                return true
            }
            return false
        }
        if case .event(.threadUpserted(_, let thread)) = metaEvent {
            #expect(thread.branch == worktreeBranch)
            let worktreePath = thread.worktreePath ?? ""
            #expect(fileManager.fileExists(atPath: worktreePath + "/README.md"))
            let checkedOut = try runGit(["branch", "--show-current"], cwd: worktreePath)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            #expect(checkedOut == worktreeBranch)
        }

        _ = try? await client.interruptTurn(threadId: threadId)
        await conn.disconnect(reason: "test complete")
        connection = nil
    } catch {
        if let connection {
            await connection.disconnect(reason: "test failed")
        }
        await terminateProcess(process)
        throw error
    }

    await terminateProcess(process)
}
