import Testing
@testable import T3Code

@Suite("Environment management presentation")
struct ConnectionHubPresentationTests {
    @Test
    func directSectionContainsOnlyDirectConnections() {
        let direct = environment(id: "direct", source: .direct)
        let managed = environment(id: "managed", source: .t3Connect)

        #expect(
            ConnectionHubPresentation.directEnvironments(in: [managed, direct]) == [direct]
        )
    }

    @Test
    func t3ConnectSectionJoinsSavedAndAccountMachinesWithoutDuplicates() {
        let saved = [
            environment(
                id: "shared",
                name: "Old saved label",
                source: .t3Connect,
                isEnabled: true,
                connectionState: .connected
            ),
            environment(id: "saved-only", source: .t3Connect, isEnabled: false),
            environment(id: "direct", source: .direct),
        ]
        let linked = [
            cloudEnvironment(id: "linked-only", name: "Travel Mac", isOnline: true),
            cloudEnvironment(id: "shared", name: "Big O", isOnline: false),
        ]

        let rows = ConnectionHubPresentation.t3ConnectEnvironments(
            saved: saved,
            linked: linked
        )

        #expect(rows.map(\.id) == ["linked-only", "shared", "saved-only"])
        #expect(rows[0].name == "Travel Mac")
        #expect(!rows[0].isEnabled)
        #expect(rows[0].isOnline)
        #expect(rows[1].name == "Big O")
        #expect(rows[1].isEnabled)
        #expect(rows[1].isOnline)
        #expect(rows[2].savedEnvironment?.id == "saved-only")
        #expect(rows[2].linkedEnvironment == nil)
    }

    private func environment(
        id: String,
        name: String? = nil,
        source: FeatureEnvironment.Source,
        isEnabled: Bool = true,
        connectionState: FeatureConnection.State? = nil
    ) -> FeatureEnvironment {
        FeatureEnvironment(
            id: id,
            name: name ?? id,
            endpoint: "https://\(id).example",
            isEnabled: isEnabled,
            source: source,
            connectionState: connectionState
        )
    }

    private func cloudEnvironment(
        id: String,
        name: String,
        isOnline: Bool
    ) -> T3ConnectCloudEnvironment {
        let endpoint = T3ConnectManagedEndpoint(
            httpBaseUrl: "https://\(id).example",
            wsBaseUrl: "wss://\(id).example",
            providerKind: .t3Relay
        )
        return T3ConnectCloudEnvironment(
            environment: T3ConnectRelayEnvironment(
                environmentId: id,
                label: name,
                endpoint: endpoint,
                linkedAt: "2026-08-14T00:00:00.000Z"
            ),
            status: T3ConnectRelayEnvironmentStatus(
                environmentId: id,
                endpoint: endpoint,
                status: isOnline ? .online : .offline,
                checkedAt: "2026-08-14T00:00:00.000Z",
                descriptor: nil,
                error: nil,
                traceId: nil
            )
        )
    }
}
