import Darwin
import Foundation

struct T3NetworkWake {
  enum WakeError: Error {
    case invalidAddress
    case socketFailure(Int32)
  }

  static func packet(macAddress: String) throws -> [UInt8] {
    let parts = macAddress.split(separator: ":", omittingEmptySubsequences: false)
    let bytes = parts.compactMap { $0.count == 2 ? UInt8($0, radix: 16) : nil }
    guard parts.count == 6, bytes.count == 6, bytes.contains(where: { $0 != 0 }), bytes[0] & 1 == 0 else {
      throw WakeError.invalidAddress
    }
    return Array(repeating: UInt8(0xff), count: 6) + Array(repeating: bytes, count: 16).flatMap { $0 }
  }

  static func broadcast(target: UInt32, local: UInt32, mask: UInt32) -> UInt32? {
    guard mask != 0, mask != UInt32.max, target != local,
      target & mask == local & mask,
      target & ~mask != 0, target & ~mask != ~mask
    else { return nil }
    return local | ~mask
  }

  static func send(address: String, macAddress: String) throws {
    let payload = try packet(macAddress: macAddress)
    var target = in_addr()
    guard inet_pton(AF_INET, address, &target) == 1 else { throw WakeError.invalidAddress }
    var interfaces: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&interfaces) == 0 else { throw WakeError.socketFailure(errno) }
    defer { freeifaddrs(interfaces) }
    var cursor = interfaces
    while let current = cursor {
      defer { cursor = current.pointee.ifa_next }
      let entry = current.pointee
      guard String(cString: entry.ifa_name) == "en0",
        entry.ifa_flags & UInt32(IFF_UP) != 0,
        let localAddress = entry.ifa_addr, localAddress.pointee.sa_family == UInt8(AF_INET),
        let netmask = entry.ifa_netmask
      else { continue }
      let local = UnsafeRawPointer(localAddress).assumingMemoryBound(to: sockaddr_in.self).pointee
      let mask = UnsafeRawPointer(netmask).assumingMemoryBound(to: sockaddr_in.self).pointee
      guard let destination = broadcast(target: target.s_addr, local: local.sin_addr.s_addr,
                                        mask: mask.sin_addr.s_addr) else { continue }
      let socket = Darwin.socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
      guard socket >= 0 else { throw WakeError.socketFailure(errno) }
      defer { Darwin.close(socket) }
      var enabled: Int32 = 1
      var interfaceIndex = if_nametoindex(entry.ifa_name)
      guard setsockopt(socket, SOL_SOCKET, SO_BROADCAST, &enabled, socklen_t(MemoryLayout.size(ofValue: enabled))) == 0,
        setsockopt(socket, IPPROTO_IP, IP_BOUND_IF, &interfaceIndex, socklen_t(MemoryLayout.size(ofValue: interfaceIndex))) == 0,
        fcntl(socket, F_SETFL, O_NONBLOCK) == 0
      else { throw WakeError.socketFailure(errno) }
      var recipient = sockaddr_in()
      recipient.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
      recipient.sin_family = sa_family_t(AF_INET)
      recipient.sin_port = UInt16(9).bigEndian
      recipient.sin_addr.s_addr = destination
      let sent = withUnsafePointer(to: &recipient) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { address in
          payload.withUnsafeBytes { bytes in
            sendto(socket, bytes.baseAddress, bytes.count, 0, address, socklen_t(MemoryLayout<sockaddr_in>.size))
          }
        }
      }
      guard sent == payload.count else { throw WakeError.socketFailure(errno) }
      return
    }
  }
}
