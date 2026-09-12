import Foundation

/// Each environment can update its limits without waiting for the other computers.
actor NativeUsageLimitsCollector {
    private var rows: [FeatureEnvironmentUsageLimits]
    private let continuation: AsyncThrowingStream<[FeatureEnvironmentUsageLimits], Error>.Continuation

    init(
        rows: [FeatureEnvironmentUsageLimits],
        continuation: AsyncThrowingStream<[FeatureEnvironmentUsageLimits], Error>.Continuation
    ) {
        self.rows = rows
        self.continuation = continuation
    }

    func update(index: Int, config: ServerConfigSnapshot) {
        let previous = rows[index]
        let next = FeatureEnvironmentUsageLimits(
            environmentID: previous.environmentID,
            label: previous.label,
            providers: config.providers,
            sources: config.usageLimitSources
        )
        guard next != previous else { return }
        rows[index] = next
        continuation.yield(rows)
    }

    func fail(index: Int, message: String) {
        let previous = rows[index]
        rows[index] = FeatureEnvironmentUsageLimits(
            environmentID: previous.environmentID,
            label: previous.label,
            providers: previous.providers,
            sources: previous.sources,
            isConnected: false,
            errorMessage: message
        )
        continuation.yield(rows)
    }
}
