import Darwin
import Foundation

/// User preference gating whether the sidecar binds beyond loopback so the
/// SergeCode mobile app can connect over the local network. Read once at
/// backend construction (App.swift) — the bind host is fixed for the life of
/// the sidecar process, so flipping the toggle takes effect on next launch.
public enum MobileAccessPreference {
    static let defaultsKey = "allowMobileConnections"

    public static var isEnabled: Bool {
        UserDefaults.standard.bool(forKey: defaultsKey)
    }

    public static func setEnabled(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: defaultsKey)
    }
}

/// Resolves this Mac's primary LAN IPv4 address (the one an iPhone on the
/// same network can reach), mirroring the server's own headless heuristic
/// (`resolveHeadlessConnectionHost` in apps/server/src/startupAccess.ts):
/// first non-internal IPv4, skipping loopback and link-local. Interfaces are
/// preferred in `en0`, `en1`, … order so Wi-Fi/Ethernet beat virtual
/// interfaces (utun/bridge) that phones can't route to.
public enum LanAddressResolver {
    public static func primaryIPv4() -> String? {
        var interfaces: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&interfaces) == 0 else { return nil }
        defer { freeifaddrs(interfaces) }

        var candidates: [(name: String, address: String)] = []
        var cursor = interfaces
        while let current = cursor {
            defer { cursor = current.pointee.ifa_next }
            let flags = Int32(current.pointee.ifa_flags)
            guard (flags & IFF_UP) != 0, (flags & IFF_LOOPBACK) == 0,
                let addressPointer = current.pointee.ifa_addr,
                addressPointer.pointee.sa_family == sa_family_t(AF_INET)
            else { continue }

            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard
                getnameinfo(
                    addressPointer, socklen_t(addressPointer.pointee.sa_len),
                    &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0
            else { continue }
            let address = String(decoding: host.prefix { $0 != 0 }.map(UInt8.init(bitPattern:)), as: UTF8.self)
            guard !address.hasPrefix("169.254.") else { continue }
            let name = String(decoding: UnsafeBufferPointer(
                start: UnsafeRawPointer(current.pointee.ifa_name).assumingMemoryBound(to: UInt8.self),
                count: strlen(current.pointee.ifa_name)), as: UTF8.self)
            candidates.append((name, address))
        }

        // Physical-style interfaces (enN) first, lowest index first, so a
        // machine with both Wi-Fi and a VPN tunnel advertises the LAN IP.
        let sorted = candidates.sorted { lhs, rhs in
            switch (lhs.name.hasPrefix("en"), rhs.name.hasPrefix("en")) {
            case (true, false): return true
            case (false, true): return false
            default: return lhs.name < rhs.name
            }
        }
        return sorted.first?.address
    }
}
