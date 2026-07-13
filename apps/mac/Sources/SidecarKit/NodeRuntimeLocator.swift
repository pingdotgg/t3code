import Darwin
import Foundation

/// A parsed `major.minor.patch` version, e.g. from `node --version` output
/// ("v22.16.0"). Pre-release/build metadata suffixes (`-rc.1`, `+build`)
/// are dropped since the engines predicate below only ever compares the
/// numeric triple.
public struct SemanticVersion: Equatable, Sendable {
    public let major: Int
    public let minor: Int
    public let patch: Int

    public init(major: Int, minor: Int, patch: Int) {
        self.major = major
        self.minor = minor
        self.patch = patch
    }

    public init?(parsing raw: String) {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("v") {
            text.removeFirst()
        }
        if let metadataIndex = text.firstIndex(where: { $0 == "-" || $0 == "+" }) {
            text = String(text[..<metadataIndex])
        }

        let parts = text.split(separator: ".")
        guard parts.count >= 2,
            let major = Int(parts[0]),
            let minor = Int(parts[1])
        else {
            return nil
        }
        let patch = parts.count >= 3 ? (Int(parts[2]) ?? 0) : 0

        self.major = major
        self.minor = minor
        self.patch = patch
    }
}

/// Locates a usable `node` binary for spawning the t3 server, mirroring the
/// dev-build expectation in ARCHITECTURE.md: "Dev builds locate node via
/// `/usr/bin/env node`" — except SidecarKit needs a concrete absolute path
/// (Foundation's `Process` does not consult `$PATH`), so it probes an
/// interactive login shell instead of relying on its own inherited
/// environment. PATH repair beyond that is the server's own job
/// (`os-jank.ts fixPath()`), not this locator's.
public struct NodeRuntimeLocator: Sendable {
    public struct LocatedNode: Sendable, Equatable {
        public let path: String
        public let version: SemanticVersion
    }

    public enum LocatorError: Error, Sendable, Equatable {
        /// No candidate path yielded an executable `node` satisfying the
        /// required engines range.
        case notFound
    }

    private let environment: [String: String]
    private nonisolated(unsafe) let fileManager: FileManager
    private let runVersionProbe: @Sendable (String) -> String?
    private let runLoginShellPathProbe: @Sendable () -> String?
    private let cachedPath: String?
    private let onLocated: (@Sendable (String) -> Void)?

    /// - Parameters:
    ///   - environment: Process environment to read `SERGECODE_NODE`/`HOME`
    ///     from. Defaults to the real process environment; tests can inject
    ///     a fixture dictionary.
    ///   - runVersionProbe: Runs `<path> --version` and returns its trimmed
    ///     stdout, or `nil` on failure. Defaults to actually spawning the
    ///     binary; tests can stub this out to avoid touching the filesystem
    ///     or spawning processes.
    ///   - cachedPath: Previously located node path. A valid cached path avoids
    ///     the login-shell probe; stale values are ignored.
    ///   - onLocated: Called when a path is newly located through the override
    ///     or normal search paths, so the caller can persist it.
    ///   - runLoginShellPathProbe: Runs the login-shell PATH probe. Defaults to
    ///     actually spawning zsh; tests can stub this out.
    public init(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        fileManager: FileManager = .default,
        runVersionProbe: (@Sendable (String) -> String?)? = nil,
        cachedPath: String? = nil,
        onLocated: (@Sendable (String) -> Void)? = nil,
        runLoginShellPathProbe: (@Sendable () -> String?)? = nil
    ) {
        self.environment = environment
        self.fileManager = fileManager
        self.runVersionProbe = runVersionProbe ?? NodeRuntimeLocator.spawnVersionProbe
        self.cachedPath = cachedPath
        self.onLocated = onLocated
        self.runLoginShellPathProbe =
            runLoginShellPathProbe ?? NodeRuntimeLocator.spawnLoginShellPath
    }

    /// Finds a usable node binary, in priority order:
    /// 1. `$SERGECODE_NODE` override
    /// 2. previously cached path, if it is still usable
    /// 3. login-shell PATH probe (`/bin/zsh -ilc 'command -v node'`)
    /// 4. common install paths (`~/.local/bin/node`, `/opt/homebrew/bin/node`,
    ///    `/usr/local/bin/node`)
    ///
    /// Each candidate must exist, be executable, and report a version
    /// satisfying the server's engines range (`^22.16 || ^23.11 || >=24.10`).
    public func locate() throws -> LocatedNode {
        if let override = environment["SERGECODE_NODE"], !override.isEmpty {
            if let located = validatedNode(at: override) {
                onLocated?(located.path)
                return located
            }
        }

        if let cachedPath, let located = validatedNode(at: cachedPath) {
            return located
        }

        var candidates: [String] = []
        if let shellNode = runLoginShellPathProbe() {
            candidates.append(shellNode)
        }
        candidates.append(contentsOf: commonCandidatePaths())

        for candidate in candidates {
            if let located = validatedNode(at: candidate) {
                onLocated?(located.path)
                return located
            }
        }

        throw LocatorError.notFound
    }

    private func validatedNode(at path: String) -> LocatedNode? {
        guard fileManager.isExecutableFile(atPath: path) else { return nil }
        guard let rawVersion = runVersionProbe(path),
            let version = SemanticVersion(parsing: rawVersion),
            Self.satisfiesEngineRange(version)
        else { return nil }
        return LocatedNode(path: path, version: version)
    }

    private static func spawnLoginShellPath() -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-ilc", "command -v node"]
        guard let output = runProbe(process) else { return nil }
        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func commonCandidatePaths() -> [String] {
        let home = environment["HOME"] ?? NSHomeDirectory()
        return [
            "\(home)/.local/bin/node",
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
        ]
    }

    private static func spawnVersionProbe(path: String) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = ["--version"]
        return runProbe(process)?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func runProbe(_ process: Process, timeout: TimeInterval = 5) -> String? {
        let stdout = Pipe()
        process.standardOutput = stdout
        process.standardError = FileHandle.nullDevice

        let output = ProbeOutput()
        let outputDrained = DispatchSemaphore(value: 0)
        stdout.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty {
                outputDrained.signal()
            } else {
                output.append(data)
            }
        }

        do {
            try process.run()
        } catch {
            stdout.fileHandleForReading.readabilityHandler = nil
            return nil
        }

        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if process.isRunning {
            process.terminate()
            let terminateDeadline = Date().addingTimeInterval(0.5)
            while process.isRunning && Date() < terminateDeadline {
                Thread.sleep(forTimeInterval: 0.05)
            }
            if process.isRunning {
                kill(process.processIdentifier, SIGKILL)
                let killDeadline = Date().addingTimeInterval(0.5)
                while process.isRunning && Date() < killDeadline {
                    Thread.sleep(forTimeInterval: 0.05)
                }
            }
        }
        guard !process.isRunning else {
            stdout.fileHandleForReading.readabilityHandler = nil
            return nil
        }
        process.waitUntilExit()
        guard outputDrained.wait(timeout: .now() + 1) == .success else {
            stdout.fileHandleForReading.readabilityHandler = nil
            return nil
        }
        stdout.fileHandleForReading.readabilityHandler = nil

        guard process.terminationStatus == 0 else { return nil }
        return String(data: output.data, encoding: .utf8)
    }

    /// Pure predicate mirroring the server's `engines.node` range from
    /// `apps/server/package.json`: `^22.16 || ^23.11 || >=24.10`. No I/O,
    /// no process spawn — safe to unit test directly.
    public static func satisfiesEngineRange(_ version: SemanticVersion) -> Bool {
        switch version.major {
        case ..<22:
            return false
        case 22:
            return (version.minor, version.patch) >= (16, 0)
        case 23:
            return (version.minor, version.patch) >= (11, 0)
        case 24:
            return (version.minor, version.patch) >= (10, 0)
        default:
            return true
        }
    }

    /// Convenience overload for callers holding raw `node --version` output.
    public static func versionSatisfies(_ rawVersion: String) -> Bool {
        guard let version = SemanticVersion(parsing: rawVersion) else { return false }
        return satisfiesEngineRange(version)
    }
}

private final class ProbeOutput: @unchecked Sendable {
    private let lock = NSLock()
    private var storage = Data()

    func append(_ data: Data) {
        lock.withLock { storage.append(data) }
    }

    var data: Data {
        lock.withLock { storage }
    }
}
