import Foundation

// Run with swiftc alongside modules/t3-native-controls/ios/T3NetworkWake.swift.
@main
struct T3NetworkWakeTests {
  static func main() throws {
    let packet = try T3NetworkWake.packet(macAddress: "aA:BB:cc:DD:ee:FF")
    precondition(packet.count == 102)
    precondition(Array(packet.prefix(6)) == Array(repeating: 0xff, count: 6))
    for index in 0..<16 {
      precondition(Array(packet[(6 + index * 6)..<(12 + index * 6)]) == [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff])
    }
    for invalid in ["", "00:00:00:00:00:00", "ff:ff:ff:ff:ff:ff", "01:02:03:04:05:06",
                    "aa:bb:cc:dd:ee", "aa:bb:cc:dd:ee:ff:00", "aa:bb:cc:dd:ee:ff:zz", "zz:bb:cc:dd:ee:ff", "a:bb:cc:dd:ee:ff"] {
      do {
        _ = try T3NetworkWake.packet(macAddress: invalid)
        preconditionFailure("Accepted invalid MAC address")
      } catch T3NetworkWake.WakeError.invalidAddress {}
    }
    precondition(T3NetworkWake.broadcast(target: 0xc0a8010a, local: 0xc0a80114, mask: 0xffffff00) == 0xc0a801ff)
    for target: UInt32 in [0xc0a8020a, 0xc0a80100, 0xc0a801ff, 0xc0a80114] {
      precondition(T3NetworkWake.broadcast(target: target, local: 0xc0a80114, mask: 0xffffff00) == nil)
    }
    precondition(T3NetworkWake.broadcast(target: 1, local: 2, mask: 0) == nil)
    precondition(T3NetworkWake.broadcast(target: 1, local: 2, mask: UInt32.max) == nil)
    print("PASS: wake packet encoding, invalid MAC rejection, same-subnet broadcast selection")
  }
}
