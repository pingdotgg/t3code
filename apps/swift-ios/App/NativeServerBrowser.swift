import Foundation

extension NativeFeatureClient: FeatureServerBrowserManaging {
    func serverBrowserUpdates(threadID: String) async throws -> AsyncThrowingStream<FeatureServerBrowserUpdate, Error> {
        let route = try threadRoute(for: threadID)
        return AsyncThrowingStream { continuation in
            let task = Task { @MainActor [weak self] in
                do {
                    await route.client.connect()
                    while !Task.isCancelled {
                        // Subscribe first so tabs closed while the list is in flight
                        // remain closed after the list has arrived.
                        let subscription = try await route.client.serverBrowserEvents()
                        do {
                            let list = try await route.client.listServerBrowsers(threadID: route.wireID)
                            guard let self else { break }
                            try self.validateServerBrowserRoute(threadID: threadID, route: route)
                            continuation.yield(.list(threadID: route.wireID, value: list))
                            for try await event in subscription.events {
                                try Task.checkCancellation()
                                try self.validateServerBrowserRoute(threadID: threadID, route: route)
                                if event.threadId == route.wireID { continuation.yield(.event(event)) }
                            }
                        } catch {
                            try Task.checkCancellation()
                            // Permanent RPC errors are shown instead of creating a retry loop.
                            if let rpcError = error as? RPCError, case .disconnected = rpcError {
                                // A replacement socket may already be connected.
                            } else { throw error }
                        }
                        _ = try await route.client.waitForConnection(after: subscription.connectionID)
                    }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func refreshServerBrowsers(threadID: String) async throws -> ServerBrowserList {
        let route = try threadRoute(for: threadID)
        let list = try await route.client.listServerBrowsers(threadID: route.wireID)
        try validateServerBrowserRoute(threadID: threadID, route: route)
        return list
    }

    func connectServerBrowser(threadID: String, tabID: String) async throws -> FeatureServerBrowserConnection {
        let route = try threadRoute(for: threadID)
        let session = try await route.client.authSession()
        guard session.grants("orchestration:read") else {
            throw EnvironmentPermissionDeniedError(requiredScope: "orchestration:read")
        }
        let access = try await route.client.serverBrowserAccess()
        try validateServerBrowserRoute(threadID: threadID, route: route)
        return .init(environmentID: route.environmentID, threadID: route.wireID, tabID: tabID,
                     access: access, interactive: session.grants("preview:operate"))
    }

    private func validateServerBrowserRoute(threadID: String, route: NativeThreadRoute) throws {
        let current = try threadRoute(for: threadID)
        guard current.environmentID == route.environmentID, current.wireID == route.wireID,
              current.client === route.client else { throw RPCError.disconnected }
    }
}
