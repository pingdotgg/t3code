import Foundation

/// Resolves the wire protocol for one environment. A saved descriptor is only
/// a display cache: each new socket checks the running server again.
actor OrchestrationConnection {
    struct Selection: Sendable {
        let descriptor: EnvironmentDescriptor
        let version: OrchestrationProtocolVersion
        let generation: Int
    }

    private let environment: Environment
    private let api: EnvironmentAPI
    private var selected: Selection?
    private var selectionIsCurrent = false
    private var validatedAt: ContinuousClock.Instant?
    private(set) var socketGeneration: Int?
    private var pending: (id: UUID, task: Task<EnvironmentDescriptor, Error>)?

    init(environment: Environment, api: EnvironmentAPI) {
        self.environment = environment
        self.api = api
    }

    func selection(refresh: Bool = false, maximumAge: Duration? = nil) async throws -> Selection {
        let withinAge = maximumAge.map { limit in
            validatedAt.map { $0.duration(to: .now) < limit } ?? false
        } ?? true
        if !refresh, withinAge, selectionIsCurrent, let selected, pending == nil { return selected }
        let read: (id: UUID, task: Task<EnvironmentDescriptor, Error>)
        if let pending {
            read = pending
        } else {
            selectionIsCurrent = false
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
                return try await selection()
            }
            let resolved = try OrchestrationProtocolSelection(
                descriptor: descriptor,
                preference: environment.orchestrationProtocolPreference,
                previousVersion: selected?.version
            )
            let generation = (selected?.generation ?? 0) + (resolved.requiresStateReset ? 1 : 0)
            let selection = Selection(descriptor: descriptor, version: resolved.version, generation: generation)
            selected = selection
            selectionIsCurrent = true
            validatedAt = .now
            pending = nil
            return selection
        } catch {
            if pending?.id == read.id { pending = nil }
            // A network or authorization failure is never evidence of V1.
            throw error
        }
    }

    /// Record the protocol of the socket being opened, not the latest HTTP read.
    func bindSocket(to selection: Selection) throws {
        try Task.checkCancellation()
        socketGeneration = selection.generation
    }
}
