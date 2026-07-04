import Darwin
import Testing

@testable import SidecarKit

@Suite("Free port picker")
struct FreePortPickerTests {
    @Test("returns a port that can actually be bound")
    func returnsBindablePort() throws {
        let port = try FreePortPicker.pick()
        #expect(port > 0)
        #expect(port < 65536)

        let fd = socket(AF_INET, SOCK_STREAM, 0)
        #expect(fd >= 0)
        defer { close(fd) }

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = UInt16(port).bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")

        let bindResult = withUnsafePointer(to: &addr) { pointer -> Int32 in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                bind(fd, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        #expect(bindResult == 0)
    }
}
