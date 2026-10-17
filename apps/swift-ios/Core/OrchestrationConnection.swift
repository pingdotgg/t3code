import Foundation

/// Validates the host for one environment. A saved descriptor is only
/// a display cache: each new socket checks the running server again.
actor OrchestrationConnection {
    private let environment: Environment
    private let api: EnvironmentAPI
    private var validatedDescriptor: EnvironmentDescriptor?
    private var descriptorIsCurrent = false
    private var validatedAt: ContinuousClock.Instant?
    private var pending: (id: UUID, task: Task<EnvironmentDescriptor, Error>)?

    init(environment: Environment, api: EnvironmentAPI) {
        self.environment = environment
        self.api = api
    }

    func descriptor(refresh: Bool = false, maximumAge: Duration? = nil) async throws -> EnvironmentDescriptor {
        let withinAge = maximumAge.map { limit in
            validatedAt.map { $0.duration(to: .now) < limit } ?? false
        } ?? true
        if !refresh, withinAge, descriptorIsCurrent, let validatedDescriptor, pending == nil {
            return validatedDescriptor
        }
        let read: (id: UUID, task: Task<EnvironmentDescriptor, Error>)
        if let pending {
            read = pending
        } else {
            descriptorIsCurrent = false
            let api = api
            let url = environment.httpBaseURL
            read = (UUID(), Task { try await api.descriptor(at: url) })
            pending = read
        }
        do {
            let descriptor = try await read.task.value
            guard descriptor.environmentId == environment.id else {
                throw EnvironmentRouteError.identityMismatch
            }
            try Task.checkCancellation()
            guard pending?.id == read.id else {
                // Another waiter already accepted this response. A newer
                // discovery, if present, must retain ownership of its result.
                return try await self.descriptor()
            }
            _ = try OrchestrationProtocolSelection(descriptor: descriptor)
            validatedDescriptor = descriptor
            descriptorIsCurrent = true
            validatedAt = .now
            pending = nil
            return descriptor
        } catch {
            if pending?.id == read.id { pending = nil }
            throw error
        }
    }
}
