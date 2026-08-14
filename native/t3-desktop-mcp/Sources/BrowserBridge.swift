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
    // Per-uid so concurrent users never share a world-writable /tmp socket.
    let shortFallback = "/tmp/t3-desktop-mcp-bridge-\(getuid()).sock"
    let preferred = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        ?? URL(fileURLWithPath: NSTemporaryDirectory())
    let dir = preferred.appendingPathComponent("t3-desktop-mcp", isDirectory: true)
    do {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    } catch {
        // Unusable Application Support — bind under /tmp so the Chrome bridge still works.
        return shortFallback
    }
    let candidate = dir.appendingPathComponent("bridge.sock").path
    // sockaddr_un.sun_path is ~104 bytes; fall back to a short /tmp path when Application
    // Support is nested too deep for bind()/connect() to succeed.
    if candidate.utf8.count > 100 {
        return shortFallback
    }
    return candidate
}()

/// Reply from the extension. A custom type rather than `Result` because the
/// failure carries a human-readable message, not an `Error`.
enum BridgeOutcome {
    case success([String: Any])
    case failure(String)
}

// MARK: - Length-prefixed framing (Chrome side)

enum NativeMessaging {
    /// Read exactly `count` bytes, treating an empty read as EOF and a short
    /// non-empty read as a fragment to keep accumulating.
    private static func readExact(_ handle: FileHandle, count: Int) -> Data? {
        var data = Data()
        data.reserveCapacity(count)
        while data.count < count {
            let needed = count - data.count
            guard let chunk = try? handle.read(upToCount: needed) else { return nil }
            if chunk.isEmpty {
                return nil
            }
            data.append(chunk)
        }
        return data
    }

    /// Read one message: 4-byte little-endian length, then that many UTF-8 bytes.
    static func read(_ handle: FileHandle) -> Data? {
        guard let header = readExact(handle, count: 4) else { return nil }
        var lengthLE: UInt32 = 0
        _ = withUnsafeMutableBytes(of: &lengthLE) { dest in
            header.copyBytes(to: dest, count: 4)
        }
        let length = UInt32(littleEndian: lengthLE)
        guard length > 0, length < 64 * 1024 * 1024 else { return nil }
        return readExact(handle, count: Int(length))
    }

    static func write(_ handle: FileHandle, _ payload: Data) {
        var lengthLE = UInt32(payload.count).littleEndian
        var framed = Data()
        withUnsafeBytes(of: &lengthLE) { framed.append(contentsOf: $0) }
        framed.append(payload)
        try? handle.write(contentsOf: framed)
    }
}

/// Write every byte, retrying EINTR and failing on other errors / short EOF.
func writeAll(_ fd: Int32, _ data: Data) -> Bool {
    data.withUnsafeBytes { rawBuffer -> Bool in
        guard var ptr = rawBuffer.bindMemory(to: UInt8.self).baseAddress else {
            return data.isEmpty
        }
        var remaining = data.count
        while remaining > 0 {
            let n = Darwin.write(fd, ptr, remaining)
            if n < 0 {
                if errno == EINTR { continue }
                return false
            }
            if n == 0 { return false }
            ptr += n
            remaining -= n
        }
        return true
    }
}

func enableNoSigPipe(_ fd: Int32) {
    var on: Int32 = 1
    _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
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
        enableNoSigPipe(fd)
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
            if !writeAll(fd, line) { exit(0) }
        }
        exit(0)
    }
}

// MARK: - Server side

/// Request/response channel to the extension, owned by the MCP server.
final class BrowserBridge {
    static let shared = BrowserBridge()

    private var listenFD: Int32 = -1
    private var ownershipLockFD: Int32 = -1
    private var clientFD: Int32 = -1
    private let lock = NSLock()
    private var nextID = 0
    private var pending: [Int: (BridgeOutcome) -> Void] = [:]

    var isConnected: Bool {
        lock.lock(); defer { lock.unlock() }
        return clientFD >= 0
    }

    private var ownershipLockPath: String { bridgeSocketPath + ".lock" }

    /// Bind the socket and accept the host connection. Silently does nothing if
    /// another server already owns it.
    func start() {
        // Cross-process exclusive lock closes the live-check / unlink / bind
        // race where two servers could both think they own the bridge.
        let lockFd = open(ownershipLockPath, O_CREAT | O_RDWR, 0o600)
        guard lockFd >= 0 else { return }
        if flock(lockFd, LOCK_EX | LOCK_NB) != 0 {
            close(lockFd)
            return
        }

        if bridgeSocketIsLive() {
            flock(lockFd, LOCK_UN)
            close(lockFd)
            return
        }
        unlink(bridgeSocketPath)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            flock(lockFd, LOCK_UN)
            close(lockFd)
            return
        }
        var addr = bridgeAddress()
        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, size) }
        }
        // Backlog of several: Chrome relaunches the host on every extension
        // reload, and a full queue makes the next connect fail outright.
        guard bound == 0, listen(fd, 8) == 0 else {
            close(fd)
            flock(lockFd, LOCK_UN)
            close(lockFd)
            return
        }
        listenFD = fd
        ownershipLockFD = lockFd

        DispatchQueue.global(qos: .utility).async { [weak self] in
            while true {
                let client = accept(fd, nil, nil)
                if client < 0 {
                    // A transient error must not retire the listener for good —
                    // that silently strands every later host launch.
                    if errno == EINTR || errno == ECONNABORTED { continue }
                    return
                }
                enableNoSigPipe(client)
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
        let semaphore = DispatchSemaphore(value: 0)
        var outcome: BridgeOutcome = .failure("timed out")

        lock.lock()
        guard clientFD >= 0 else {
            lock.unlock()
            return .failure("the T3 Code Chrome extension is not connected")
        }
        nextID += 1
        let id = nextID
        let fd = clientFD
        let payload: [String: Any] = ["id": id, "command": command, "params": params]
        guard var data = try? JSONSerialization.data(withJSONObject: payload) else {
            lock.unlock()
            return .failure("could not encode the command")
        }
        data.append(0x0A)
        // Register before unlocking so a disconnect that races the write still
        // drains this waiter with a disconnect failure instead of a timeout.
        pending[id] = { result in
            outcome = result
            semaphore.signal()
        }
        lock.unlock()

        if !writeAll(fd, data) {
            lock.lock()
            pending.removeValue(forKey: id)
            lock.unlock()
            return .failure("the browser extension disconnected")
        }

        if semaphore.wait(timeout: .now() + timeout) == .timedOut {
            lock.lock(); pending.removeValue(forKey: id); lock.unlock()
            return .failure("the extension did not respond in \(Int(timeout))s")
        }
        return outcome
    }
}
