import CryptoKit
import XCTest
@testable import T3Code

final class T3ConnectRuntimeTests: XCTestCase {
    func testLegacyCredentialsRemainBearerAndManagedMetadataIsRedacted() async throws {
        let legacy = Data(#"{"accessToken":"legacy-secret","scopes":["read"]}"#.utf8)
        let decoded = try JSONDecoder.t3.decode(EnvironmentCredential.self, from: legacy)
        XCTAssertEqual(decoded.authorizationMethod, .bearer)
        XCTAssertEqual(decoded.accessToken, "legacy-secret")
        XCTAssertThrowsError(
            try JSONDecoder.t3.decode(
                EnvironmentCredential.self,
                from: Data(#"{"accessToken":"secret","authorizationMethod":"dpop"}"#.utf8)
            )
        )

        let managed = EnvironmentCredential.managedDPoP(
            accessToken: "managed-secret",
            expiresAt: Date(timeIntervalSince1970: 2_000_000_000),
            scopes: ["orchestration:read"],
            environmentID: "managed-1",
            proofKeyThumbprint: "proof-key"
        )
        XCTAssertFalse(String(describing: managed).contains("managed-secret"))
        XCTAssertFalse(String(reflecting: managed).contains("managed-secret"))
        XCTAssertEqual(
            try JSONDecoder.t3.decode(
                EnvironmentCredential.self,
                from: JSONEncoder.t3.encode(managed)
            ),
            managed
        )

        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-connect-redaction-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let catalogURL = directory.appendingPathComponent("environments.json")
        let store = EnvironmentStore(fileURL: catalogURL)
        try await store.save([
            managedEnvironment(descriptor: descriptor(environmentID: "managed-1")),
        ])
        let catalog = try String(contentsOf: catalogURL, encoding: .utf8)
        XCTAssertTrue(catalog.contains("managed-dpop"))
        XCTAssertFalse(catalog.contains("managed-secret"))
        XCTAssertFalse(catalog.contains("proof-key"))
    }

    func testEveryManagedHTTPRequestGetsFreshDPoPProof() async throws {
        let signer = try testSigner()
        let thumbprint = try await signer.thumbprint()
        let transport = T3ConnectScriptedHTTPTransport { request, _ in
            XCTAssertEqual(request.url?.path, "/api/auth/session")
            return (.authSession, 200)
        }
        let authorizer = T3ConnectManagedEnvironmentAuthorizer(
            transport: transport,
            signer: signer
        )
        let runtimeAuthorization = T3ConnectRuntimeAuthorization(
            authorizer: authorizer,
            bootstrapProvider: { _ in throw T3ConnectTestError.unexpectedRefresh }
        )
        let environment = managedEnvironment(descriptor: descriptor())
        let credentials = InMemoryCredentialStore(credentials: [
            environment.id: .managedDPoP(
                accessToken: "bound-token",
                expiresAt: Date().addingTimeInterval(300),
                scopes: T3ConnectManagedEnvironmentAuthorizer.standardScopes,
                environmentID: environment.id,
                proofKeyThumbprint: thumbprint
            ),
        ])
        let api = EnvironmentAPI(
            transport: transport,
            credentials: credentials,
            managedAuthorization: runtimeAuthorization
        )

        _ = try await api.session(for: environment)
        _ = try await api.session(for: environment)

        let requests = await transport.requests
        XCTAssertEqual(requests.count, 2)
        XCTAssertTrue(requests.allSatisfy {
            $0.value(forHTTPHeaderField: "Authorization") == "DPoP bound-token"
        })
        let proofs = requests.compactMap { $0.value(forHTTPHeaderField: "DPoP") }
        XCTAssertEqual(proofs.count, 2)
        XCTAssertNotEqual(proofs[0], proofs[1])
        XCTAssertFalse(requests.contains {
            $0.value(forHTTPHeaderField: "Authorization")?.hasPrefix("Bearer ") == true
        })
        XCTAssertTrue(requests.allSatisfy {
            $0.value(forHTTPHeaderField: "Accept-Encoding") == "gzip"
        })
    }

    func testManagedRoutesReplaceAdvertisedBasePath() async throws {
        let signer = try testSigner()
        let transport = T3ConnectScriptedHTTPTransport { request, ordinal in
            switch ordinal {
            case 1:
                return (.descriptor, 200)
            case 2:
                return (
                    .token(
                        scopes: T3ConnectManagedEnvironmentAuthorizer.standardScopes
                            .joined(separator: " ")
                    ),
                    200
                )
            case 3:
                return (.webSocketTicket("canonical-ticket"), 200)
            default:
                throw T3ConnectTestError.unexpectedPath(request.url?.path)
            }
        }
        let authorizer = T3ConnectManagedEnvironmentAuthorizer(
            transport: transport,
            signer: signer
        )
        let endpoint = T3ConnectManagedEndpoint(
            httpBaseUrl: "https://managed.example/advertised/prefix?stale=true",
            wsBaseUrl: "wss://managed.example/ws",
            providerKind: .t3Relay
        )
        let bootstrap = T3ConnectManagedEnvironmentCredential(
            environmentID: "managed-1",
            label: "Managed Studio",
            endpoint: endpoint,
            bootstrapCredential: "one-use-bootstrap",
            bootstrapExpiresAt: "2026-08-01T12:00:00.000Z",
            proofKeyThumbprint: try await signer.thumbprint()
        )

        _ = try await authorizer.descriptor(at: try XCTUnwrap(endpoint.httpBaseURL))
        let authorization = try await authorizer.exchange(bootstrap)
        _ = try await authorizer.webSocketURL(using: authorization)

        let requests = await transport.requests
        XCTAssertEqual(
            requests.map(\.url?.path),
            [
                "/.well-known/t3/environment",
                "/oauth/token",
                "/api/auth/websocket-ticket",
            ]
        )
        XCTAssertTrue(requests.allSatisfy { $0.url?.query == nil })
    }

    func testSixtySecondMarginRefreshesAndPersistsBeforeFirstRequest() async throws {
        let fixture = try await refreshFixture(
            savedThumbprint: nil,
            expiresAt: Date().addingTimeInterval(45)
        )

        _ = try await fixture.api.session(for: fixture.environment)

        let refreshCalls = await fixture.bootstrap.calls
        XCTAssertEqual(refreshCalls, 1)
        let saved = await fixture.credentials.credential(for: fixture.environment.id)
        XCTAssertEqual(saved?.accessToken, "fresh-environment-token")
        XCTAssertEqual(saved?.authorizationMethod, .dpop)
        let requests = await fixture.transport.requests
        XCTAssertEqual(
            requests.map(\.url?.path),
            ["/.well-known/t3/environment", "/oauth/token", "/api/auth/session"]
        )
        XCTAssertEqual(
            requests.last?.value(forHTTPHeaderField: "Authorization"),
            "DPoP fresh-environment-token"
        )
    }

    func testConcurrentExpiryRefreshIsSingleFlight() async throws {
        let fixture = try await refreshFixture(
            savedThumbprint: nil,
            expiresAt: Date().addingTimeInterval(-1)
        )

        async let first = fixture.api.session(for: fixture.environment)
        async let second = fixture.secondAPI.session(for: fixture.environment)
        _ = try await (first, second)

        let refreshCalls = await fixture.bootstrap.calls
        XCTAssertEqual(refreshCalls, 1)
        let refreshRequests = await fixture.transport.requests
        let paths = refreshRequests.map(\.url?.path)
        XCTAssertEqual(paths.filter { $0 == "/oauth/token" }.count, 1)
        XCTAssertEqual(paths.filter { $0 == "/api/auth/session" }.count, 2)
    }

    func testCancellingRefreshWaiterDoesNotBreakSingleFlight() async throws {
        let signer = try testSigner()
        let environment = managedEnvironment(descriptor: descriptor())
        let replacing = EnvironmentCredential.managedDPoP(
            accessToken: "expired-token",
            expiresAt: Date().addingTimeInterval(-1),
            scopes: T3ConnectManagedEnvironmentAuthorizer.standardScopes,
            environmentID: environment.id,
            proofKeyThumbprint: try await signer.thumbprint()
        )
        let source = BlockingT3ConnectBootstrapSource(
            credential: try await bootstrapCredential(signer: signer)
        )
        let transport = T3ConnectScriptedHTTPTransport { request, _ in
            switch request.url?.path {
            case "/.well-known/t3/environment":
                return (.descriptor, 200)
            case "/oauth/token":
                return (
                    .token(
                        scopes: T3ConnectManagedEnvironmentAuthorizer.standardScopes
                            .joined(separator: " ")
                    ),
                    200
                )
            default:
                throw T3ConnectTestError.unexpectedPath(request.url?.path)
            }
        }
        let authorization = T3ConnectRuntimeAuthorization(
            authorizer: T3ConnectManagedEnvironmentAuthorizer(
                transport: transport,
                signer: signer
            ),
            bootstrapProvider: { id in try await source.value(for: id) }
        )

        let first = Task {
            try await authorization.refreshCredential(
                for: environment,
                replacing: replacing
            )
        }
        await source.waitUntilCallCount(1)
        first.cancel()
        let secondStarted = AsyncTestMarker()
        let second = Task {
            await secondStarted.mark()
            return try await authorization.refreshCredential(
                for: environment,
                replacing: replacing
            )
        }
        await secondStarted.waitUntilMarked()
        await Task.yield()
        await source.release()

        let firstCredential = try await first.value
        let secondCredential = try await second.value
        XCTAssertEqual(firstCredential, secondCredential)
        let calls = await source.calls
        XCTAssertEqual(calls, 1)
    }

    func testRotatedProofKeyRebindsFreshCredential() async throws {
        let fixture = try await refreshFixture(
            savedThumbprint: "stale-proof-key",
            expiresAt: Date().addingTimeInterval(300)
        )

        _ = try await fixture.api.session(for: fixture.environment)

        let refreshCalls = await fixture.bootstrap.calls
        XCTAssertEqual(refreshCalls, 1)
        let currentThumbprint = try await fixture.signer.thumbprint()
        let saved = await fixture.credentials.credential(for: fixture.environment.id)
        XCTAssertEqual(saved?.proofKeyThumbprint, currentThumbprint)
        XCTAssertEqual(saved?.accessToken, "fresh-environment-token")
    }

    func testStaggered401ReusesNewerSavedCredentialWithoutSecondMint() async throws {
        let signer = try testSigner()
        let thumbprint = try await signer.thumbprint()
        let environment = managedEnvironment(descriptor: descriptor())
        let original = EnvironmentCredential.managedDPoP(
            accessToken: "old-token",
            expiresAt: Date().addingTimeInterval(300),
            scopes: T3ConnectManagedEnvironmentAuthorizer.standardScopes,
            environmentID: environment.id,
            proofKeyThumbprint: thumbprint
        )
        let newer = EnvironmentCredential.managedDPoP(
            accessToken: "newer-token",
            expiresAt: Date().addingTimeInterval(300),
            scopes: original.scopes,
            environmentID: environment.id,
            proofKeyThumbprint: thumbprint
        )
        let credentials = InMemoryCredentialStore(credentials: [environment.id: original])
        let transport = T3ConnectStaggered401Transport(
            credentialStore: credentials,
            environmentID: environment.id,
            newerCredential: newer
        )
        let bootstrap = T3ConnectBootstrapSource(
            credential: try await bootstrapCredential(signer: signer)
        )
        let authorizer = T3ConnectManagedEnvironmentAuthorizer(
            transport: transport,
            signer: signer
        )
        let runtimeAuthorization = T3ConnectRuntimeAuthorization(
            authorizer: authorizer,
            bootstrapProvider: { id in try await bootstrap.value(for: id) }
        )
        let api = EnvironmentAPI(
            transport: transport,
            credentials: credentials,
            managedAuthorization: runtimeAuthorization
        )

        _ = try await api.session(for: environment)

        let refreshCalls = await bootstrap.calls
        XCTAssertEqual(refreshCalls, 0)
        let requests = await transport.requests
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(
            requests.map { $0.value(forHTTPHeaderField: "Authorization") },
            ["DPoP old-token", "DPoP newer-token"]
        )
        XCTAssertNotEqual(
            requests[0].value(forHTTPHeaderField: "DPoP"),
            requests[1].value(forHTTPHeaderField: "DPoP")
        )
    }

    func testRejectedTokenRefreshesOnceAndRetriesWithANewProof() async throws {
        let signer = try testSigner()
        let thumbprint = try await signer.thumbprint()
        let environment = managedEnvironment(descriptor: descriptor())
        let credentials = InMemoryCredentialStore(credentials: [
            environment.id: .managedDPoP(
                accessToken: "rejected-token",
                expiresAt: Date().addingTimeInterval(300),
                scopes: T3ConnectManagedEnvironmentAuthorizer.standardScopes,
                environmentID: environment.id,
                proofKeyThumbprint: thumbprint
            ),
        ])
        let transport = T3ConnectScriptedHTTPTransport { request, ordinal in
            switch (request.url?.path, ordinal) {
            case ("/api/auth/session", 1):
                return (Data(#"{"message":"expired"}"#.utf8), 401)
            case ("/.well-known/t3/environment", 2):
                return (.descriptor, 200)
            case ("/oauth/token", 3):
                return (.token(scopes: T3ConnectManagedEnvironmentAuthorizer.standardScopes
                    .joined(separator: " ")), 200)
            case ("/api/auth/session", 4):
                return (.authSession, 200)
            default:
                throw T3ConnectTestError.unexpectedPath(request.url?.path)
            }
        }
        let bootstrap = T3ConnectBootstrapSource(
            credential: try await bootstrapCredential(signer: signer)
        )
        let authorizer = T3ConnectManagedEnvironmentAuthorizer(
            transport: transport,
            signer: signer
        )
        let runtimeAuthorization = T3ConnectRuntimeAuthorization(
            authorizer: authorizer,
            bootstrapProvider: { id in try await bootstrap.value(for: id) }
        )
        let api = EnvironmentAPI(
            transport: transport,
            credentials: credentials,
            managedAuthorization: runtimeAuthorization
        )

        _ = try await api.session(for: environment)

        let refreshCalls = await bootstrap.calls
        XCTAssertEqual(refreshCalls, 1)
        let requests = await transport.requests
        let sessionRequests = requests.filter { $0.url?.path == "/api/auth/session" }
        XCTAssertEqual(sessionRequests.count, 2)
        XCTAssertEqual(
            sessionRequests.map { $0.value(forHTTPHeaderField: "Authorization") },
            ["DPoP rejected-token", "DPoP fresh-environment-token"]
        )
        XCTAssertNotEqual(
            sessionRequests[0].value(forHTTPHeaderField: "DPoP"),
            sessionRequests[1].value(forHTTPHeaderField: "DPoP")
        )
    }

    func testRefreshDescriptorMismatchDoesNotReplaceSavedCredential() async throws {
        let signer = try testSigner()
        let thumbprint = try await signer.thumbprint()
        let environment = managedEnvironment(descriptor: descriptor())
        let original = EnvironmentCredential.managedDPoP(
            accessToken: "saved-token",
            expiresAt: Date().addingTimeInterval(-1),
            scopes: T3ConnectManagedEnvironmentAuthorizer.standardScopes,
            environmentID: environment.id,
            proofKeyThumbprint: thumbprint
        )
        let credentials = InMemoryCredentialStore(credentials: [environment.id: original])
        let transport = T3ConnectScriptedHTTPTransport { request, _ in
            guard request.url?.path == "/.well-known/t3/environment" else {
                throw T3ConnectTestError.unexpectedPath(request.url?.path)
            }
            return (.descriptor("another-environment"), 200)
        }
        let bootstrap = T3ConnectBootstrapSource(
            credential: try await bootstrapCredential(signer: signer)
        )
        let authorizer = T3ConnectManagedEnvironmentAuthorizer(
            transport: transport,
            signer: signer
        )
        let api = EnvironmentAPI(
            transport: transport,
            credentials: credentials,
            managedAuthorization: T3ConnectRuntimeAuthorization(
                authorizer: authorizer,
                bootstrapProvider: { id in try await bootstrap.value(for: id) }
            )
        )

        do {
            _ = try await api.session(for: environment)
            XCTFail("Refresh accepted a descriptor for another environment")
        } catch T3ConnectRelayError.environmentMismatch {
            // Expected identity rejection.
        }
        let saved = await credentials.credential(for: environment.id)
        XCTAssertEqual(saved, original)
        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.url?.path), ["/.well-known/t3/environment"])
    }

    func testWebSocketReconnectMintsAOneUseTicketEveryTime() async throws {
        let signer = try testSigner()
        let thumbprint = try await signer.thumbprint()
        let environment = managedEnvironment(descriptor: descriptor())
        let credentials = InMemoryCredentialStore(credentials: [
            environment.id: .managedDPoP(
                accessToken: "socket-token",
                expiresAt: Date().addingTimeInterval(300),
                scopes: T3ConnectManagedEnvironmentAuthorizer.standardScopes,
                environmentID: environment.id,
                proofKeyThumbprint: thumbprint
            ),
        ])
        let transport = T3ConnectScriptedHTTPTransport { request, ordinal in
            XCTAssertEqual(request.url?.path, "/api/auth/websocket-ticket")
            return (.webSocketTicket("ticket-\(ordinal)"), 200)
        }
        let authorizer = T3ConnectManagedEnvironmentAuthorizer(
            transport: transport,
            signer: signer
        )
        let runtimeAuthorization = T3ConnectRuntimeAuthorization(
            authorizer: authorizer,
            bootstrapProvider: { _ in throw T3ConnectTestError.unexpectedRefresh }
        )
        let connector = T3ConnectReconnectConnector()
        let client = T3Client(
            environment: environment,
            credentialStore: credentials,
            httpTransport: transport,
            webSocketConnector: connector,
            managedAuthorization: runtimeAuthorization
        )

        await client.connect()
        await connector.waitForConnectionCount(2)
        await client.disconnect()

        let urls = await connector.urls
        XCTAssertEqual(urls.prefix(2).map { ticket(in: $0) }, ["ticket-1", "ticket-2"])
        XCTAssertFalse(urls.prefix(2).contains(environment.webSocketBaseURL))
        XCTAssertFalse(urls.prefix(2).contains { $0.absoluteString.contains("socket-token") })
        let requests = await transport.requests
        XCTAssertGreaterThanOrEqual(requests.count, 2)
        XCTAssertNotEqual(
            requests[0].value(forHTTPHeaderField: "DPoP"),
            requests[1].value(forHTTPHeaderField: "DPoP")
        )
    }

    func testManagedWebSocketRejectsUnencryptedEndpointBeforeMintingTicket() async throws {
        let signer = try testSigner()
        let transport = T3ConnectScriptedHTTPTransport { request, _ in
            throw T3ConnectTestError.unexpectedPath(request.url?.path)
        }
        let authorizer = T3ConnectManagedEnvironmentAuthorizer(
            transport: transport,
            signer: signer
        )
        let authorization = T3ConnectEnvironmentAccessToken(
            environmentID: "managed-1",
            label: "Managed Studio",
            endpoint: T3ConnectManagedEndpoint(
                httpBaseUrl: "https://managed.example",
                wsBaseUrl: "ws://managed.example/ws",
                providerKind: .t3Relay
            ),
            accessToken: "access-token",
            expiresAt: Date().addingTimeInterval(300),
            scopes: T3ConnectManagedEnvironmentAuthorizer.standardScopes,
            proofKeyThumbprint: try await signer.thumbprint()
        )

        do {
            _ = try await authorizer.webSocketURL(using: authorization)
            XCTFail("An unencrypted managed WebSocket endpoint was accepted")
        } catch let error as T3ConnectRelayError {
            guard case .invalidConfiguration = error else {
                return XCTFail("Unexpected T3 Connect error: \(error)")
            }
        }
        let requests = await transport.requests
        XCTAssertTrue(requests.isEmpty)
    }

    func testEnvironmentExchangeRejectsMalformedTokenContracts() async throws {
        let signer = try testSigner()
        let bootstrap = try await bootstrapCredential(signer: signer)
        let validScopes = T3ConnectManagedEnvironmentAuthorizer.standardScopes.joined(separator: " ")
        let invalidBodies = [
            Data.token(accessToken: "", scopes: validScopes),
            Data.token(issuedTokenType: "wrong", scopes: validScopes),
            Data.token(expiresIn: 0, scopes: validScopes),
            Data.token(scopes: "orchestration:read"),
        ]

        for body in invalidBodies {
            let transport = T3ConnectScriptedHTTPTransport { _, _ in (body, 200) }
            let authorizer = T3ConnectManagedEnvironmentAuthorizer(
                transport: transport,
                signer: signer
            )
            do {
                _ = try await authorizer.exchange(bootstrap)
                XCTFail("Malformed environment token response was accepted")
            } catch is T3ConnectRelayError {
                // Expected contract rejection.
            }
        }
    }

    func testRelayTokenCacheNeverCrossesClerkAccounts() async throws {
        let signer = try testSigner()
        let transport = T3ConnectScriptedHTTPTransport { request, ordinal in
            switch (request.url?.path, ordinal) {
            case ("/v1/client/dpop-token", 1):
                return (.relayToken("relay-account-a"), 200)
            case ("/v1/environments/managed-1/status", 2):
                return (.relayStatus, 200)
            case ("/v1/client/dpop-token", 3):
                return (.relayToken("relay-account-b"), 200)
            case ("/v1/environments/managed-1/status", 4):
                return (.relayStatus, 200)
            default:
                throw T3ConnectTestError.unexpectedPath(request.url?.path)
            }
        }
        let relay = T3ConnectRelayClient(
            configuration: T3ConnectConfiguration(
                clerkPublishableKey: "pk_test",
                relayHTTPURL: URL(string: "https://relay.example")!
            ),
            transport: transport,
            signer: signer
        )
        let record = T3ConnectRelayEnvironment(
            environmentId: "managed-1",
            label: "Managed Studio",
            endpoint: T3ConnectManagedEndpoint(
                httpBaseUrl: "https://managed.example",
                wsBaseUrl: "wss://managed.example",
                providerKind: .t3Relay
            ),
            linkedAt: "2026-08-01T12:00:00.000Z"
        )

        _ = try await relay.status(for: record, clerkToken: clerkJWT(subject: "account-a"))
        _ = try await relay.status(for: record, clerkToken: clerkJWT(subject: "account-b"))

        let requests = await transport.requests
        XCTAssertEqual(requests.filter { $0.url?.path == "/v1/client/dpop-token" }.count, 2)
        XCTAssertEqual(
            requests.filter { $0.url?.path.hasSuffix("/status") == true }
                .map { $0.value(forHTTPHeaderField: "Authorization") },
            ["DPoP relay-account-a", "DPoP relay-account-b"]
        )
    }

    func testRelayMobileDeliveryEndpointsUseBoundDPoPRequests() async throws {
        let signer = try testSigner()
        let transport = T3ConnectScriptedHTTPTransport { request, ordinal in
            switch ordinal {
            case 1:
                XCTAssertEqual(request.url?.path, "/v1/client/dpop-token")
                return (.relayToken("relay-mobile", scope: "mobile:registration"), 200)
            case 2, 3, 4:
                return (Data(#"{"ok":true}"#.utf8), 200)
            default:
                throw T3ConnectTestError.unexpectedPath(request.url?.path)
            }
        }
        let relay = T3ConnectRelayClient(
            configuration: T3ConnectConfiguration(
                clerkPublishableKey: "pk_test",
                relayHTTPURL: URL(string: "https://relay.example")!
            ),
            transport: transport,
            signer: signer
        )
        let clerkToken = clerkJWT(subject: "mobile-account")
        let device = T3ConnectDeviceRegistration(
            deviceID: "phone-1",
            label: "Big O",
            iosMajorVersion: 26,
            bundleID: "com.t3tools.t3code.swiftui",
            apsEnvironment: .sandbox,
            pushToken: "apns-token",
            pushToStartToken: "start-token"
        )

        try await relay.registerDevice(device, clerkToken: clerkToken)
        try await relay.registerLiveActivity(
            T3ConnectLiveActivityRegistration(
                deviceID: "phone-1",
                activityPushToken: "activity-token"
            ),
            clerkToken: clerkToken
        )
        try await relay.unregisterDevice(deviceID: "phone-1", clerkToken: clerkToken)

        let requests = await transport.requests
        XCTAssertEqual(
            requests.dropFirst().map(\.url?.path),
            [
                "/v1/mobile/devices",
                "/v1/mobile/live-activities",
                "/v1/mobile/devices/phone-1",
            ]
        )
        XCTAssertEqual(requests.last?.httpMethod, "DELETE")
        let proofs = requests.dropFirst().compactMap {
            $0.value(forHTTPHeaderField: "DPoP")
        }
        XCTAssertEqual(proofs.count, 3)
        XCTAssertEqual(Set(proofs).count, 3)
        XCTAssertTrue(requests.dropFirst().allSatisfy {
            $0.value(forHTTPHeaderField: "Authorization") == "DPoP relay-mobile"
        })
    }

    func testRelayRoutesReplaceConfiguredBasePathAndQuery() async throws {
        let signer = try testSigner()
        let transport = T3ConnectScriptedHTTPTransport { request, ordinal in
            switch ordinal {
            case 1:
                XCTAssertEqual(request.url?.path, "/v1/client/dpop-token")
                XCTAssertNil(request.url?.query)
                return (.relayToken("relay-mobile", scope: "mobile:registration"), 200)
            case 2:
                XCTAssertEqual(request.url?.path, "/v1/mobile/devices")
                XCTAssertNil(request.url?.query)
                return (Data(#"{"ok":true}"#.utf8), 200)
            default:
                throw T3ConnectTestError.unexpectedPath(request.url?.path)
            }
        }
        let relay = T3ConnectRelayClient(
            configuration: T3ConnectConfiguration(
                clerkPublishableKey: "pk_test",
                relayHTTPURL: URL(string: "https://relay.example/stale/base?old=true")!
            ),
            transport: transport,
            signer: signer
        )

        try await relay.registerDevice(
            testDeviceRegistration(),
            clerkToken: clerkJWT(subject: "mobile-account")
        )
    }

    func testRelayRejectsFalseOKResponse() async throws {
        let signer = try testSigner()
        let transport = T3ConnectScriptedHTTPTransport { _, ordinal in
            switch ordinal {
            case 1:
                return (.relayToken("relay-mobile", scope: "mobile:registration"), 200)
            case 2:
                return (Data(#"{"ok":false}"#.utf8), 200)
            default:
                throw T3ConnectTestError.unexpectedPath(nil)
            }
        }
        let relay = T3ConnectRelayClient(
            configuration: T3ConnectConfiguration(
                clerkPublishableKey: "pk_test",
                relayHTTPURL: URL(string: "https://relay.example")!
            ),
            transport: transport,
            signer: signer
        )

        do {
            try await relay.registerDevice(
                testDeviceRegistration(),
                clerkToken: clerkJWT(subject: "mobile-account")
            )
            XCTFail("A false success envelope was accepted")
        } catch T3ConnectRelayError.invalidResponse {
            // Expected contract rejection.
        }
    }

    func testRelayRejectsMalformedAccessTokenContracts() async throws {
        let invalidTokens = [
            Data.relayToken("", scope: "mobile:registration"),
            Data(
                #"{"access_token":"token","issued_token_type":"wrong","token_type":"DPoP","expires_in":300,"scope":"mobile:registration"}"#.utf8
            ),
            Data(
                #"{"access_token":"token","issued_token_type":"urn:ietf:params:oauth:token-type:access_token","token_type":"DPoP","expires_in":0,"scope":"mobile:registration"}"#.utf8
            ),
        ]

        for token in invalidTokens {
            let signer = try testSigner()
            let transport = T3ConnectScriptedHTTPTransport { _, _ in (token, 200) }
            let relay = T3ConnectRelayClient(
                configuration: T3ConnectConfiguration(
                    clerkPublishableKey: "pk_test",
                    relayHTTPURL: URL(string: "https://relay.example")!
                ),
                transport: transport,
                signer: signer
            )
            do {
                try await relay.registerDevice(
                    testDeviceRegistration(),
                    clerkToken: clerkJWT(subject: "mobile-account")
                )
                XCTFail("A malformed relay access token was accepted")
            } catch T3ConnectRelayError.invalidResponse {
                // Expected contract rejection.
            }
        }
    }

    func testRelayRejectsBlankBootstrapCredential() async throws {
        let signer = try testSigner()
        let transport = T3ConnectScriptedHTTPTransport { _, ordinal in
            switch ordinal {
            case 1:
                return (.relayToken("relay-connect", scope: "environment:connect"), 200)
            case 2:
                return (
                    Data(
                        #"{"environmentId":"managed-1","endpoint":{"httpBaseUrl":"https://managed.example","wsBaseUrl":"wss://managed.example","providerKind":"t3_relay"},"credential":"","expiresAt":""}"#.utf8
                    ),
                    200
                )
            default:
                throw T3ConnectTestError.unexpectedPath(nil)
            }
        }
        let relay = T3ConnectRelayClient(
            configuration: T3ConnectConfiguration(
                clerkPublishableKey: "pk_test",
                relayHTTPURL: URL(string: "https://relay.example")!
            ),
            transport: transport,
            signer: signer
        )
        let environment = T3ConnectRelayEnvironment(
            environmentId: "managed-1",
            label: "Managed Studio",
            endpoint: T3ConnectManagedEndpoint(
                httpBaseUrl: "https://managed.example",
                wsBaseUrl: "wss://managed.example",
                providerKind: .t3Relay
            ),
            linkedAt: "2026-08-01T12:00:00.000Z"
        )

        do {
            _ = try await relay.connect(
                to: environment,
                clerkToken: clerkJWT(subject: "mobile-account")
            )
            XCTFail("A blank environment bootstrap credential was accepted")
        } catch T3ConnectRelayError.invalidResponse {
            // Expected contract rejection.
        }
    }

    private func testDeviceRegistration() -> T3ConnectDeviceRegistration {
        T3ConnectDeviceRegistration(
            deviceID: "phone-1",
            label: "Big O",
            iosMajorVersion: 26,
            bundleID: "com.t3tools.t3code.swiftui",
            apsEnvironment: .sandbox,
            pushToken: "apns-token",
            pushToStartToken: "start-token"
        )
    }

    private func refreshFixture(
        savedThumbprint: String?,
        expiresAt: Date
    ) async throws -> T3ConnectRefreshFixture {
        let signer = try testSigner()
        let currentThumbprint = try await signer.thumbprint()
        let environment = managedEnvironment(descriptor: descriptor())
        let credentials = InMemoryCredentialStore(credentials: [
            environment.id: .managedDPoP(
                accessToken: "saved-token",
                expiresAt: expiresAt,
                scopes: T3ConnectManagedEnvironmentAuthorizer.standardScopes,
                environmentID: environment.id,
                proofKeyThumbprint: savedThumbprint ?? currentThumbprint
            ),
        ])
        let transport = T3ConnectScriptedHTTPTransport { request, _ in
            switch request.url?.path {
            case "/.well-known/t3/environment":
                return (.descriptor, 200)
            case "/oauth/token":
                return (.token(scopes: T3ConnectManagedEnvironmentAuthorizer.standardScopes
                    .joined(separator: " ")), 200)
            case "/api/auth/session":
                return (.authSession, 200)
            default:
                throw T3ConnectTestError.unexpectedPath(request.url?.path)
            }
        }
        let bootstrap = T3ConnectBootstrapSource(
            credential: try await bootstrapCredential(signer: signer)
        )
        let authorizer = T3ConnectManagedEnvironmentAuthorizer(
            transport: transport,
            signer: signer
        )
        let runtimeAuthorization = T3ConnectRuntimeAuthorization(
            authorizer: authorizer,
            bootstrapProvider: { id in try await bootstrap.value(for: id) }
        )
        return T3ConnectRefreshFixture(
            signer: signer,
            environment: environment,
            credentials: credentials,
            transport: transport,
            bootstrap: bootstrap,
            api: EnvironmentAPI(
                transport: transport,
                credentials: credentials,
                managedAuthorization: runtimeAuthorization
            ),
            secondAPI: EnvironmentAPI(
                transport: transport,
                credentials: credentials,
                managedAuthorization: runtimeAuthorization
            )
        )
    }

    private func testSigner() throws -> T3ConnectDPoPSigner {
        var scalar = Data(repeating: 0, count: 32)
        scalar[31] = 7
        return try T3ConnectDPoPSigner(privateKeyRawRepresentation: scalar)
    }

    private func descriptor(environmentID: String = "managed-1") -> EnvironmentDescriptor {
        try! JSONDecoder.t3.decode(EnvironmentDescriptor.self, from: .descriptor(environmentID))
    }

    private func managedEnvironment(descriptor: EnvironmentDescriptor) -> Environment {
        Environment(
            id: descriptor.environmentId,
            label: descriptor.label,
            httpBaseURL: URL(string: "https://managed.example")!,
            webSocketBaseURL: URL(string: "wss://managed.example")!,
            kind: .managedDPoP,
            descriptor: descriptor
        )
    }

    private func bootstrapCredential(
        signer: T3ConnectDPoPSigner
    ) async throws -> T3ConnectManagedEnvironmentCredential {
        T3ConnectManagedEnvironmentCredential(
            environmentID: "managed-1",
            label: "Managed Studio",
            endpoint: T3ConnectManagedEndpoint(
                httpBaseUrl: "https://managed.example",
                wsBaseUrl: "wss://managed.example",
                providerKind: .t3Relay
            ),
            bootstrapCredential: "one-use-bootstrap",
            bootstrapExpiresAt: "2026-08-01T12:00:00.000Z",
            proofKeyThumbprint: try await signer.thumbprint()
        )
    }

    private func ticket(in url: URL) -> String? {
        URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
            .first(where: { $0.name == "wsTicket" })?.value
    }

    private func clerkJWT(subject: String) -> String {
        let header = Data(#"{"alg":"none"}"#.utf8).testBase64URL()
        let payload = Data(#"{"sub":"\#(subject)"}"#.utf8).testBase64URL()
        return "\(header).\(payload).signature"
    }
}

private struct T3ConnectRefreshFixture {
    let signer: T3ConnectDPoPSigner
    let environment: Environment
    let credentials: InMemoryCredentialStore
    let transport: T3ConnectScriptedHTTPTransport
    let bootstrap: T3ConnectBootstrapSource
    let api: EnvironmentAPI
    let secondAPI: EnvironmentAPI
}

private enum T3ConnectTestError: Error {
    case unexpectedRefresh
    case unexpectedPath(String?)
}

private actor T3ConnectBootstrapSource {
    private let credential: T3ConnectManagedEnvironmentCredential
    private(set) var calls = 0

    init(credential: T3ConnectManagedEnvironmentCredential) {
        self.credential = credential
    }

    func value(for environmentID: String) throws -> T3ConnectManagedEnvironmentCredential {
        guard environmentID == credential.environmentID else {
            throw T3ConnectTestError.unexpectedPath(environmentID)
        }
        calls += 1
        return credential
    }
}

private actor BlockingT3ConnectBootstrapSource {
    private let credential: T3ConnectManagedEnvironmentCredential
    private var released = false
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []
    private var callWaiters: [(Int, CheckedContinuation<Void, Never>)] = []
    private(set) var calls = 0

    init(credential: T3ConnectManagedEnvironmentCredential) {
        self.credential = credential
    }

    func value(for environmentID: String) async throws
        -> T3ConnectManagedEnvironmentCredential
    {
        guard environmentID == credential.environmentID else {
            throw T3ConnectTestError.unexpectedPath(environmentID)
        }
        calls += 1
        let ready = callWaiters.filter { calls >= $0.0 }
        callWaiters.removeAll { calls >= $0.0 }
        ready.forEach { $0.1.resume() }
        if !released {
            await withCheckedContinuation { continuation in
                releaseWaiters.append(continuation)
            }
        }
        return credential
    }

    func waitUntilCallCount(_ count: Int) async {
        guard calls < count else { return }
        await withCheckedContinuation { continuation in
            callWaiters.append((count, continuation))
        }
    }

    func release() {
        released = true
        let waiters = releaseWaiters
        releaseWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }
}

private actor AsyncTestMarker {
    private var marked = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func mark() {
        marked = true
        let pending = waiters
        waiters.removeAll()
        pending.forEach { $0.resume() }
    }

    func waitUntilMarked() async {
        guard !marked else { return }
        await withCheckedContinuation { continuation in
            waiters.append(continuation)
        }
    }
}

private actor T3ConnectScriptedHTTPTransport: HTTPTransport {
    typealias Handler = @Sendable (URLRequest, Int) throws -> (Data, Int)

    private let handler: Handler
    private(set) var requests: [URLRequest] = []

    init(handler: @escaping Handler) {
        self.handler = handler
    }

    func data(for request: URLRequest) throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        let (data, status) = try handler(request, requests.count)
        return (data, response(request, status: status))
    }
}

private actor T3ConnectStaggered401Transport: HTTPTransport {
    private let credentialStore: InMemoryCredentialStore
    private let environmentID: String
    private let newerCredential: EnvironmentCredential
    private(set) var requests: [URLRequest] = []

    init(
        credentialStore: InMemoryCredentialStore,
        environmentID: String,
        newerCredential: EnvironmentCredential
    ) {
        self.credentialStore = credentialStore
        self.environmentID = environmentID
        self.newerCredential = newerCredential
    }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        if requests.count == 1 {
            await credentialStore.setCredential(newerCredential, for: environmentID)
            return (Data(#"{"message":"expired"}"#.utf8), response(request, status: 401))
        }
        return (.authSession, response(request, status: 200))
    }
}

private actor T3ConnectReconnectConnector: WebSocketConnecting {
    private(set) var urls: [URL] = []
    private var waiters: [(Int, CheckedContinuation<Void, Never>)] = []

    func connect(to url: URL) -> any WebSocketConnection {
        urls.append(url)
        let ready = waiters.filter { urls.count >= $0.0 }
        waiters.removeAll { urls.count >= $0.0 }
        ready.forEach { $0.1.resume() }
        return T3ConnectFailingReceiveConnection()
    }

    func waitForConnectionCount(_ count: Int) async {
        guard urls.count < count else { return }
        await withCheckedContinuation { continuation in
            waiters.append((count, continuation))
        }
    }
}

private actor T3ConnectFailingReceiveConnection: WebSocketConnection {
    func send(_: Data) {}
    func receive() throws -> Data { throw URLError(.networkConnectionLost) }
    func close() {}
}

private extension Data {
    static var authSession: Data {
        Data(#"{"authenticated":true,"scopes":[],"sessionMethod":"dpop","expiresAt":null}"#.utf8)
    }

    static var descriptor: Data { descriptor("managed-1") }

    static func descriptor(_ environmentID: String) -> Data {
        Data(
            """
            {
              "environmentId": "\(environmentID)",
              "label": "Managed Studio",
              "platform": {"os": "darwin", "arch": "arm64"},
              "serverVersion": "1.0.0",
              "capabilities": {"repositoryIdentity": true}
            }
            """.utf8
        )
    }

    static func token(
        accessToken: String = "fresh-environment-token",
        issuedTokenType: String = "urn:ietf:params:oauth:token-type:access_token",
        expiresIn: Double = 300,
        scopes: String
    ) -> Data {
        Data(
            """
            {
              "access_token": "\(accessToken)",
              "issued_token_type": "\(issuedTokenType)",
              "token_type": "DPoP",
              "expires_in": \(expiresIn),
              "scope": "\(scopes)"
            }
            """.utf8
        )
    }

    static func webSocketTicket(_ ticket: String) -> Data {
        Data(
            #"{"ticket":"\#(ticket)","expiresAt":"2026-08-01T12:05:00.000Z"}"#.utf8
        )
    }

    static func relayToken(_ token: String, scope: String = "environment:status") -> Data {
        Data(
            """
            {
              "access_token": "\(token)",
              "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
              "token_type": "DPoP",
              "expires_in": 300,
              "scope": "\(scope)"
            }
            """.utf8
        )
    }

    static var relayStatus: Data {
        Data(
            """
            {
              "environmentId": "managed-1",
              "endpoint": {
                "httpBaseUrl": "https://managed.example",
                "wsBaseUrl": "wss://managed.example",
                "providerKind": "t3_relay"
              },
              "status": "online",
              "checkedAt": "2026-08-01T12:00:00.000Z",
              "descriptor": null,
              "error": null,
              "traceId": null
            }
            """.utf8
        )
    }

    func testBase64URL() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

private func response(_ request: URLRequest, status: Int) -> HTTPURLResponse {
    HTTPURLResponse(
        url: request.url!,
        statusCode: status,
        httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"]
    )!
}
