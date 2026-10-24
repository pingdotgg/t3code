import Foundation

extension NativeFeatureClient: FeatureStorageMaintenance {
    func storageMaintenanceAvailability(environmentID: String) async throws -> FeatureStorageMaintenanceAvailability {
        let client = try await environmentServiceClient(environmentID: environmentID)
        let config = try await client.serverConfig()
        let permissions = EnvironmentPermissionState(session: try await client.authSession(), serverAuth: config.auth)
        return .init(
            databaseStorage: config.environment?.capabilities.databaseStorage == true,
            storageCleanupRun: config.environment?.capabilities.storageCleanupRun == true,
            canRead: permissions.grants("orchestration:read"),
            canRun: permissions.grants("settings:write"),
            hasRules: config.settings?.hasEnabledStorageCleanupRules == true
        )
    }

    func getDatabaseStorage(environmentID: String) async throws -> AsyncThrowingStream<DatabaseStorageStatus?, Error> {
        let client = try await environmentServiceClient(environmentID: environmentID)
        guard try await client.serverConfig().environment?.capabilities.databaseStorage == true else {
            throw FeatureCapabilityUnavailable("Database storage")
        }
        try await requireScope("orchestration:read", client: client)
        return await client.getDatabaseStorage()
    }

    func getStorageCleanupReport(environmentID: String) async throws -> AsyncThrowingStream<StorageCleanupReport?, Error> {
        let client = try await environmentServiceClient(environmentID: environmentID)
        guard try await client.serverConfig().environment?.capabilities.storageCleanupRun == true else {
            throw FeatureCapabilityUnavailable("Storage cleanup")
        }
        try await requireScope("orchestration:read", client: client)
        return await client.getStorageCleanupReport()
    }

    func runStorageCleanup(environmentID: String) async throws -> StorageCleanupReport {
        let key = NativeStorageCleanupFlights.Key(owner: ObjectIdentifier(self), environmentID: environmentID)
        guard NativeStorageCleanupFlights.running.insert(key).inserted else {
            throw FeatureStorageMaintenanceError.cleanupInProgress
        }
        defer { NativeStorageCleanupFlights.running.remove(key) }
        let client = try await environmentServiceClient(environmentID: environmentID)
        guard try await client.serverConfig().environment?.capabilities.storageCleanupRun == true else {
            throw FeatureCapabilityUnavailable("Storage cleanup")
        }
        try await requireScope("settings:write", client: client)
        return try await client.runStorageCleanup()
    }
}

// Separate settings views must share the command's per-environment single-flight guard.
@MainActor
private enum NativeStorageCleanupFlights {
    struct Key: Hashable {
        let owner: ObjectIdentifier
        let environmentID: String
    }
    static var running: Set<Key> = []
}
