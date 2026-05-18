import Foundation

struct MobileReconnectPolicy: Equatable, Sendable {
    let maxAttempts: Int
    let retryDelayNanoseconds: UInt64

    static let immediate = MobileReconnectPolicy(maxAttempts: 1, retryDelayNanoseconds: 0)
    static let appDefault = MobileReconnectPolicy(maxAttempts: 2, retryDelayNanoseconds: 300_000_000)
}
