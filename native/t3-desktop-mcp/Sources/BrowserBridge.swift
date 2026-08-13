import Foundation

// Bridge between the MCP server and the Chrome extension.
//
// Chrome owns the lifetime of a native messaging host: it spawns the host
// process when the extension connects and speaks 4-byte-length-prefixed JSON
// over that process's stdio. The MCP server is a different process with its own
// lifetime, so the two are joined by a Unix socket:
//
//     Chrome  ──stdio(length-prefixed)──▶  `t3-desktop-mcp native-host`
//                                              │ unix socket
//                                              ▼
//                                        MCP server (this process)
//
// The server binds the socket, so the first live server claims the browser;
// later ones simply fall back to the accessibility path.

let bridgeSocketPath: String = {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        ?? URL(fileURLWithPath: NSTemporaryDirectory())
    let dir = base.appendingPathComponent("t3-desktop-mcp", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("bridge.sock").path
}()

/// Reply from the extension. A custom type rather than `Result` because the
/// failure carries a human-readable message, not an `Error`.
enum BridgeOutcome {
    case success([String: Any])
    case failure(String)
}

// MARK: - Length-prefixed framing (Chrome side)

enum NativeMessaging {
    /// Read one message: 4-byte native-endian length, then that many UTF-8 bytes.
    static func read(_ handle: FileHandle) -> Data? {
        guard let header = try? handle.read(upToCount: 4), header.count == 4 else { return nil }
        let length = header.withUnsafeBytes { $0.load(as: UInt32.self) }
        guard length > 0, length < 64 * 1024 * 1024 else { return nil }
        guard let body = try? handle.read(upToCount: Int(length)), body.count == Int(length) else {
            return nil
        }
        return body
    }

    static func write(_ handle: FileHandle, _ payload: Data) {
        var length = UInt32(payload.count)
        var framed = Data(bytes: &length, count: 4)
        framed.append(payload)
        try? handle.write(contentsOf: framed)
    }
}

/// Fill in a `sockaddr_un` for the bridge path.
func bridgeAddress() -> sockaddr_un {
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    _ = withUnsafeMutablePointer(to: &addr.sun_path) { pathPtr in
        bridgeSocketPath.withCString { src in
            strncpy(UnsafeMutableRawPointer(pathPtr).assumingMemoryBound(to: CChar.self), src, 103)
        }
    }
    return addr
}

/// Whether a server is already listening on the bridge socket.
///
/// The socket file outlives the process that made it, so its presence proves
/// nothing — only a successful connect distinguishes a live owner from a stale
/// file left behind by a crash.
func bridgeSocketIsLive() -> Bool {
    guard FileManager.default.fileExists(atPath: bridgeSocketPath) else { return false }
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    var addr = bridgeAddress()
    let size = socklen_t(MemoryLayout<sockaddr_un>.size)
    return withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, size) }
    } == 0
}

// MARK: - Host mode

/// `t3-desktop-mcp native-host` — relays between Chrome's stdio and the socket.
/// Chrome launches this; it is not the MCP server.
enum NativeHost {
    static func run() -> Never {
        let input = FileHandle.standardInput
        let output = FileHandle.standardOutput

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { exit(1) }
        var addr = bridgeAddress()
        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let connected = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, size) }
        }
        guard connected == 0 else { exit(1) }

        // Socket → Chrome. Server speaks newline-delimited JSON.
        DispatchQueue.global().async {
            var buffer = Data()
            var chunk = [UInt8](repeating: 0, count: 65536)
            while true {
                let n = Darwin.read(fd, &chunk, chunk.count)
                if n <= 0 { exit(0) }
                buffer.append(contentsOf: chunk[0..<n])
                while let newline = buffer.firstIndex(of: 0x0A) {
                    let line = buffer[buffer.startIndex..<newline]
                    buffer = buffer[buffer.index(after: newline)...]
                    if !line.isEmpty { NativeMessaging.write(output, Data(line)) }
                }
            }
        }

        // Chrome → socket.
        while let message = NativeMessaging.read(input) {
            var line = message
            line.append(0x0A)
            _ = line.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
        }
        exit(0)
    }
}

// MARK: - Server side

/// Request/response channel to the extension, owned by the MCP server.
final class BrowserBridge {
    static let shared = BrowserBridge()

    private var listenFD: Int32 = -1
    private var clientFD: Int32 = -1
    private let lock = NSLock()
    private var nextID = 0
    private var pending: [Int: (BridgeOutcome) -> Void] = [:]

    var isConnected: Bool {
        lock.lock(); defer { lock.unlock() }
        return clientFD >= 0
    }

    /// Bind the socket and accept the host connection. Silently does nothing if
    /// another server already owns it.
    func start() {
        // Defer to a server that is already listening. Unlinking and rebinding
        // would silently take the browser away from whichever session is using
        // it, and the victim would keep reporting success while doing nothing.
        if bridgeSocketIsLive() { return }
        unlink(bridgeSocketPath)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return }
        var addr = bridgeAddress()
        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, size) }
        }
        // Backlog of several: Chrome relaunches the host on every extension
        // reload, and a full queue makes the next connect fail outright.
        guard bound == 0, listen(fd, 8) == 0 else { close(fd); return }
        listenFD = fd

        DispatchQueue.global(qos: .utility).async { [weak self] in
            while true {
                let client = accept(fd, nil, nil)
                if client < 0 {
                    // A transient error must not retire the listener for good —
                    // that silently strands every later host launch.
                    if errno == EINTR || errno == ECONNABORTED { continue }
                    return
                }
                self?.serve(client)
            }
        }
    }

    private func serve(_ fd: Int32) {
        lock.lock(); clientFD = fd; lock.unlock()
        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 65536)
        while true {
            let n = Darwin.read(fd, &chunk, chunk.count)
            if n <= 0 { break }
            buffer.append(contentsOf: chunk[0..<n])
            while let newline = buffer.firstIndex(of: 0x0A) {
                let line = Data(buffer[buffer.startIndex..<newline])
                buffer = buffer[buffer.index(after: newline)...]
                handle(line)
            }
        }
        lock.lock()
        clientFD = -1
        let stranded = pending
        pending.removeAll()
        lock.unlock()
        for (_, resume) in stranded { resume(.failure("the browser extension disconnected")) }
        close(fd)
    }

    private func handle(_ line: Data) {
        guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
              let id = object["id"] as? Int else { return }
        lock.lock()
        let resume = pending.removeValue(forKey: id)
        lock.unlock()
        guard let resume else { return }
        if object["ok"] as? Bool == true {
            resume(.success(object["result"] as? [String: Any] ?? [:]))
        } else {
            resume(.failure((object["error"] as? String) ?? "the extension reported an error"))
        }
    }

    /// Send a command and wait for its reply.
    func call(_ command: String, _ params: [String: Any] = [:], timeout: TimeInterval = 20)
        -> BridgeOutcome
    {
        lock.lock()
        guard clientFD >= 0 else {
            lock.unlock()
            return .failure("the T3 Code Chrome extension is not connected")
        }
        nextID += 1
        let id = nextID
        let fd = clientFD
        lock.unlock()

        let semaphore = DispatchSemaphore(value: 0)
        var outcome: BridgeOutcome = .failure("timed out")
        lock.lock()
        pending[id] = { result in
            outcome = result
            semaphore.signal()
        }
        lock.unlock()

        let payload: [String: Any] = ["id": id, "command": command, "params": params]
        guard var data = try? JSONSerialization.data(withJSONObject: payload) else {
            return .failure("could not encode the command")
        }
        data.append(0x0A)
        _ = data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }

        if semaphore.wait(timeout: .now() + timeout) == .timedOut {
            lock.lock(); pending.removeValue(forKey: id); lock.unlock()
            return .failure("the extension did not respond in \(Int(timeout))s")
        }
        return outcome
    }
}
