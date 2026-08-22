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
    func directSectionShowsEnabledConnectionsBeforeDisabledConnections() {
        let disabledFirst = environment(
            id: "disabled-first",
            source: .direct,
            isEnabled: false
        )
        let enabledFirst = environment(id: "enabled-first", source: .direct)
        let disabledSecond = environment(
            id: "disabled-second",
            source: .direct,
            isEnabled: false
        )
        let enabledSecond = environment(id: "enabled-second", source: .direct)

        #expect(
            ConnectionHubPresentation.directEnvironments(
                in: [disabledFirst, enabledFirst, disabledSecond, enabledSecond]
            ).map(\.id) == [
                "enabled-first",
                "enabled-second",
                "disabled-first",
                "disabled-second",
            ]
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

    @Test(
        arguments: [
            (FeatureConnection.State.connected, ConnectionHubStatus.online),
            (.connecting, .connecting),
            (.reconnecting, .connecting),
            (.disconnected, .offline),
        ]
    )
    func savedEnvironmentStatusMatchesConnectionState(
        connectionState: FeatureConnection.State,
        expectedStatus: ConnectionHubStatus
    ) {
        let saved = environment(
            id: "direct",
            source: .direct,
            connectionState: connectionState
        )

        #expect(ConnectionHubPresentation.status(for: saved) == expectedStatus)
    }

    @Test
    func disabledEnvironmentDoesNotAppearOfflineOrOnline() {
        let saved = environment(
            id: "disabled",
            source: .direct,
            isEnabled: false,
            connectionState: .connected
        )

        #expect(ConnectionHubPresentation.status(for: saved) == .disabled)
        #expect(ConnectionHubPresentation.status(for: saved, pendingEnabled: true) == .connecting)
    }

    @Test
    func environmentWithoutAReachabilityProbeIsChecking() {
        let saved = environment(id: "pending", source: .direct)

        #expect(ConnectionHubPresentation.status(for: saved) == .checking)
        #expect(ConnectionHubPresentation.status(for: saved, pendingEnabled: false) == .disabled)
    }

    @Test
    func managedEnvironmentUsesSavedConnectionStateBeforeCloudAvailability() {
        let linked = cloudEnvironment(id: "managed", name: "Studio", isOnline: true)
        let disabled = T3ConnectEnvironmentPresentation(
            linkedEnvironment: linked,
            savedEnvironment: environment(
                id: "managed",
                source: .t3Connect,
                isEnabled: false,
                connectionState: .connected
            )
        )
        let offline = T3ConnectEnvironmentPresentation(
            linkedEnvironment: linked,
            savedEnvironment: environment(
                id: "managed",
                source: .t3Connect,
                connectionState: .disconnected
            )
        )

        #expect(disabled.status == .disabled)
        #expect(offline.status == .offline)
        #expect(!disabled.isOnline)
        #expect(!offline.isOnline)
    }

    @Test
    func linkedEnvironmentShowsCloudStatusUntilItIsSaved() {
        let online = T3ConnectEnvironmentPresentation(
            linkedEnvironment: cloudEnvironment(id: "online", name: "Studio", isOnline: true),
            savedEnvironment: nil
        )
        let offline = T3ConnectEnvironmentPresentation(
            linkedEnvironment: cloudEnvironment(id: "offline", name: "Studio", isOnline: false),
            savedEnvironment: nil
        )

        #expect(online.status == .online)
        #expect(offline.status == .offline)
        #expect(online.connectionStatus(pendingEnabled: true) == .connecting)
        #expect(offline.connectionStatus(isConnecting: true) == .connecting)
    }

    @Test
    func linkedEnvironmentSeparatesUnknownStatusFromFailedReachability() {
        let linked = cloudEnvironment(id: "linked", name: "Studio", isOnline: true)
        let unchecked = T3ConnectEnvironmentPresentation(
            linkedEnvironment: T3ConnectCloudEnvironment(environment: linked.environment),
            savedEnvironment: nil
        )
        let failed = T3ConnectEnvironmentPresentation(
            linkedEnvironment: T3ConnectCloudEnvironment(
                environment: linked.environment,
                statusError: "Connection failed"
            ),
            savedEnvironment: nil
        )

        #expect(unchecked.status == .checking)
        #expect(failed.status == .offline)
    }

    @Test
    func duplicateMachineNamesShowOnlyTheirSanitizedHostAndPort() {
        let names = ["leftbook", "LeftBook", "studio"]

        #expect(
            ConnectionHubPresentation.disambiguatingEndpoint(
                "https://agent:secret@leftbook.tailnet.ts.net:8443/work?token=private#code",
                for: "leftbook",
                among: names
            ) == "leftbook.tailnet.ts.net:8443"
        )
        #expect(
            ConnectionHubPresentation.disambiguatingEndpoint(
                "https://second.tailnet.ts.net/private?token=hidden",
                for: "LeftBook",
                among: names
            ) == "second.tailnet.ts.net"
        )
        #expect(
            ConnectionHubPresentation.disambiguatingEndpoint(
                "https://studio.example/",
                for: "studio",
                among: names
            ) == nil
        )
    }

    @Test
    func managedEnvironmentUsesLinkedEndpointForDisambiguation() {
        let linked = cloudEnvironment(id: "linked", name: "leftbook", isOnline: true)
        let row = T3ConnectEnvironmentPresentation(
            linkedEnvironment: linked,
            savedEnvironment: environment(id: "saved", name: "leftbook", source: .t3Connect)
        )

        #expect(row.endpoint == "https://linked.example")
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
