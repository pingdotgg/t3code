import Darwin
import Foundation

/// Resolves the dev-build default location of the t3 server entry point,
/// mirroring ARCHITECTURE.md's `<repoRoot>/apps/server/dist/bin.mjs`.
/// Packaged builds must inject an explicit `entryPath` instead (bundling a
/// Node runtime + server into the .app is a post-v1 packaging task).
public enum SidecarEntryPathResolver {
    /// Walks up from this source file's on-disk location
    /// (`apps/mac/Sources/SidecarKit/SidecarConfig.swift`) to the repo root,
    /// then appends `apps/server/dist/bin.mjs`. Only meaningful for local
    /// checkouts where SidecarKit's sources live at their usual path.
    public static func devDefaultEntryPath(sourceFile: String = #filePath) -> String {
        // `#filePath` is not reliably absolute here: the app-bundle build
        // invokes swiftc with `-working-directory <repo>/apps`, baking a
        // value that resolves to `<repo>/apps/apps/...` at runtime — which
        // broke the old fixed five-component walk. Walk upward instead and
        // take the first ancestor that actually contains the built entry.
        var url = URL(fileURLWithPath: sourceFile).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = url.appendingPathComponent("apps/server/dist/bin.mjs")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate.path
            }
            url.deleteLastPathComponent()
        }
        // Nothing found (server not built yet / sources moved): fall back to
        // the historical repo-root guess so error messages still name a
        // plausible path.
        var fixed = URL(fileURLWithPath: sourceFile)
        for _ in 0..<5 {
            fixed.deleteLastPathComponent()
        }
        return fixed.appendingPathComponent("apps/server/dist/bin.mjs").path
    }
}

/// Picks an available loopback TCP port by binding to port 0 (letting the
/// kernel assign one), reading it back via `getsockname`, then closing the
/// socket. There is an inherent TOCTOU race between closing this probe
/// socket and the caller binding the same port — acceptable for a local dev
/// supervisor where nothing else on the machine is aggressively racing for
/// ports.
public enum FreePortPicker {
    public enum PickError: Error, Sendable {
        case socketCreationFailed
        case bindFailed
        case getsocknameFailed
    }

    public static func pick(host: String = "127.0.0.1") throws -> Int {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw PickError.socketCreationFailed }
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
        guard bindResult == 0 else { throw PickError.bindFailed }

        var boundAddr = sockaddr_in()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let getsocknameResult = withUnsafeMutablePointer(to: &boundAddr) { pointer -> Int32 in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                getsockname(fd, sockaddrPointer, &length)
            }
        }
        guard getsocknameResult == 0 else { throw PickError.getsocknameFailed }

        return Int(UInt16(bigEndian: boundAddr.sin_port))
    }
}

/// Everything `ServerProcess` needs to spawn and supervise one t3 server
/// child: binary location, argv-relevant values, and where its logs go.
public struct SidecarConfig: Sendable {
    public var nodePath: String
    public var entryPath: String
    public var port: Int
    public var host: String
    public var baseDir: String
    public var logDirectory: String
    public var noBrowser: Bool

    /// - Parameters:
    ///   - nodePath: Absolute path to a `node` binary, typically from
    ///     `NodeRuntimeLocator.locate()`.
    ///   - entryPath: Path to `dist/bin.mjs`. Defaults to the dev-checkout
    ///     location; packaged builds must override this.
    ///   - port: Loopback port to bind. Defaults to `FreePortPicker.pick()`;
    ///     pass a fixed value to override.
    ///   - baseDir: Server state directory. Defaults to
    ///     `~/Library/Application Support/SergeCode`, distinct from any
    ///     Electron install's state dir.
    ///   - logDirectory: Where rotated stdout/stderr logs land. Defaults to
    ///     `<baseDir>/logs/sidecar`.
    public init(
        nodePath: String,
        entryPath: String = SidecarEntryPathResolver.devDefaultEntryPath(),
        port: Int? = nil,
        host: String = "127.0.0.1",
        baseDir: String? = nil,
        logDirectory: String? = nil,
        noBrowser: Bool = true
    ) throws {
        self.nodePath = nodePath
        self.entryPath = entryPath
        self.port = try port ?? FreePortPicker.pick(host: host)
        self.host = host
        let resolvedBaseDir = baseDir ?? SidecarConfig.defaultBaseDir()
        self.baseDir = resolvedBaseDir
        self.logDirectory =
            logDirectory ?? (resolvedBaseDir as NSString).appendingPathComponent("logs/sidecar")
        self.noBrowser = noBrowser
    }

    /// `~/Library/Application Support/SergeCode` — kept distinct from any
    /// Electron desktop install's `T3CODE_HOME` so the two never share a
    /// SQLite file.
    public static func defaultBaseDir(fileManager: FileManager = .default) -> String {
        let appSupport =
            fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(
                "Library/Application Support")
        return appSupport.appendingPathComponent("SergeCode").path
    }
}
