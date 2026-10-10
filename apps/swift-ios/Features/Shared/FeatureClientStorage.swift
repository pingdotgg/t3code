import Foundation

/// Disposable saved reads only. Clearing storage preserves all user-authored data.
@MainActor
protocol FeatureClientStorageManaging: AnyObject {
    func clientStorageSummary() async throws -> FeatureClientStorageSummary
    /// A nil environment ID clears disposable storage for every environment.
    func clearClientStorage(environmentID: String?) async throws
}

struct FeatureClientStorageSummary: Equatable, Sendable {
    var environments: [FeatureEnvironmentStorageSummary]

    var totalBytes: Int64 { environments.reduce(0) { $0 + $1.totalBytes } }
}

struct FeatureEnvironmentStorageSummary: Identifiable, Equatable, Sendable {
    var environmentID: String
    var label: String
    var shellCount: Int
    var threadCount: Int
    var faviconCount: Int
    var totalBytes: Int64

    var id: String { environmentID }
}
