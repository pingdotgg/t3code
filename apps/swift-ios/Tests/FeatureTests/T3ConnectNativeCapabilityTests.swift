import CryptoKit
import XCTest
@testable import T3Code

@MainActor
final class T3ConnectNativeCapabilityTests: XCTestCase {
    func testNativeConnectValidatesPersistsActivatesAndPublishesImmediately() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-connect-native-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let catalogURL = directory.appendingPathComponent("environments.json")
        let store = EnvironmentStore(fileURL: catalogURL)
        let credentials = InMemoryCredentialStore()
        let signer = try testSigner()
        let transport = T3ConnectNativeHTTPTransport(descriptorEnvironmentID: "managed-1")
        let controller = T3ConnectController(
            resolution: .unavailable(reason: "Authentication is injected by this test."),
            transport: transport,
            signer: signer
        )
        let runtime = EnvironmentRuntime(
            environmentStore: store,
            credentialStore: credentials,
            httpTransport: transport,
            webSocketConnector: T3ConnectBlockingConnector(),
            managedAuthorization: T3ConnectRuntimeAuthorization(controller: controller)
        )
        let client = NativeFeatureClient(
            runtime: runtime,
            t3ConnectController: controller,
            fallbackPollingInitialDelay: .seconds(30)
        )
        var events = client.events().makeAsyncIterator()
        let managed = try await bootstrapCredential(signer: signer)

        try await client.connectT3Environment(managed)

        let event = await events.next()
        guard case let .snapshot(snapshot)? = event else {
            return XCTFail("Managed connect did not publish its initial Home snapshot")
        }
        XCTAssertEqual(snapshot.connection.state, .connected)
        XCTAssertEqual(snapshot.connection.environmentName, "Managed Studio")

        let saved = try await store.load()
        XCTAssertEqual(saved.count, 1)
        XCTAssertEqual(saved[0].id, "managed-1")
        XCTAssertEqual(saved[0].kind, .managedDPoP)
        let activeEnvironmentID = try await store.activeEnvironmentID()
        XCTAssertEqual(activeEnvironmentID, "managed-1")
        let credential = await credentials.credential(for: "managed-1")
        XCTAssertEqual(credential?.authorizationMethod, .dpop)
        XCTAssertEqual(credential?.accessToken, "native-access-token")
        XCTAssertNotEqual(credential?.accessToken, managed.bootstrapCredential)

        let catalog = try String(contentsOf: catalogURL, encoding: .utf8)
        XCTAssertFalse(catalog.contains("one-use-bootstrap"))
        XCTAssertFalse(catalog.contains("native-access-token"))
        XCTAssertFalse(catalog.contains("ws-ticket"))

        let requests = await transport.requests
        XCTAssertEqual(
            Array(requests.prefix(3).map(\.url?.path)),
            ["/.well-known/t3/environment", "/oauth/token", "/api/orchestration/shell"]
        )
        let shellRequest = try XCTUnwrap(
            requests.first(where: { $0.url?.path == "/api/orchestration/shell" })
        )
        XCTAssertEqual(
            shellRequest.value(forHTTPHeaderField: "Authorization"),
            "DPoP native-access-token"
        )
        XCTAssertNotNil(shellRequest.value(forHTTPHeaderField: "DPoP"))
        await client.disconnect()
    }

    func testDescriptorMismatchLeavesManualEnvironmentAndCredentialsUntouched() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-connect-mismatch-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let manual = Environment(
            id: "manual-1",
            label: "Big O",
            httpBaseURL: URL(string: "https://big-o.example")!,
            webSocketBaseURL: URL(string: "wss://big-o.example")!
        )
        let store = EnvironmentStore(
            fileURL: directory.appendingPathComponent("environments.json")
        )
        try await store.save([manual])
        try await store.setActiveEnvironment(id: manual.id)
        let manualCredential = EnvironmentCredential(accessToken: "manual-secret")
        let credentials = InMemoryCredentialStore(credentials: [manual.id: manualCredential])
        let signer = try testSigner()
        let transport = T3ConnectNativeHTTPTransport(descriptorEnvironmentID: "wrong-server")
        let controller = T3ConnectController(
            resolution: .unavailable(reason: "Authentication is injected by this test."),
            transport: transport,
            signer: signer
        )
        let runtime = EnvironmentRuntime(
            environmentStore: store,
            credentialStore: credentials,
            httpTransport: transport,
            webSocketConnector: T3ConnectBlockingConnector(),
            managedAuthorization: T3ConnectRuntimeAuthorization(controller: controller)
        )
        let client = NativeFeatureClient(runtime: runtime, t3ConnectController: controller)

        do {
            try await client.connectT3Environment(
                try await bootstrapCredential(signer: signer)
            )
            XCTFail("A descriptor for another environment was accepted")
        } catch T3ConnectRelayError.environmentMismatch {
            // Expected identity rejection.
        }

        let savedEnvironments = try await store.load()
        let activeEnvironmentID = try await store.activeEnvironmentID()
        let savedManualCredential = await credentials.credential(for: manual.id)
        let savedManagedCredential = await credentials.credential(for: "managed-1")
        XCTAssertEqual(savedEnvironments, [manual])
        XCTAssertEqual(activeEnvironmentID, manual.id)
        XCTAssertEqual(savedManualCredential, manualCredential)
        XCTAssertNil(savedManagedCredential)
        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.url?.path), ["/.well-known/t3/environment"])
    }

    func testInjectedRuntimeWithoutManagedAuthorizationReportsUnavailable() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-connect-unavailable-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let runtime = EnvironmentRuntime(
            environmentStore: EnvironmentStore(
                fileURL: directory.appendingPathComponent("environments.json")
            ),
            credentialStore: InMemoryCredentialStore()
        )
        let client = NativeFeatureClient(runtime: runtime)
        XCTAssertNotNil(client.t3ConnectController.unavailableReason)

        let signer = try testSigner()
        do {
            try await client.connectT3Environment(
                try await bootstrapCredential(signer: signer)
            )
            XCTFail("An unconfigured runtime presented a working managed connection")
        } catch let error as T3ConnectRelayError {
            guard case .invalidConfiguration = error else {
                return XCTFail("Unexpected T3 Connect error: \(error)")
            }
        }
    }

    func testSignOutRemovesManagedStateWhenClerkFailsAndPreservesManualPairing() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-connect-sign-out-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let manual = Environment(
            id: "manual-1",
            label: "Big O",
            httpBaseURL: URL(string: "http://100.64.0.1:3773")!,
            webSocketBaseURL: URL(string: "ws://100.64.0.1:3773/ws")!
        )
        let managed = Environment(
            id: "managed-1",
            label: "Managed Studio",
            httpBaseURL: URL(string: "https://managed.example")!,
            webSocketBaseURL: URL(string: "wss://managed.example")!,
            kind: .managedDPoP
        )
        let store = EnvironmentStore(
            fileURL: directory.appendingPathComponent("environments.json")
        )
        try await store.save([managed, manual])
        try await store.setActiveEnvironment(id: managed.id)
        let manualCredential = EnvironmentCredential(accessToken: "manual-secret")
        let managedCredential = EnvironmentCredential.managedDPoP(
            accessToken: "managed-secret",
            expiresAt: Date().addingTimeInterval(300),
            scopes: T3ConnectManagedEnvironmentAuthorizer.standardScopes,
            environmentID: managed.id,
            proofKeyThumbprint: "proof-key"
        )
        let credentials = InMemoryCredentialStore(
            credentials: [
                manual.id: manualCredential,
                managed.id: managedCredential,
            ]
        )
        let signer = try testSigner()
        let transport = T3ConnectNativeHTTPTransport(descriptorEnvironmentID: managed.id)
        let controller = T3ConnectController(
            resolution: .available(
                T3ConnectConfiguration(
                    clerkPublishableKey: "pk_test",
                    relayHTTPURL: URL(string: "https://relay.example")!
                )
            ),
            transport: transport,
            signer: signer,
            signOutOperation: { throw T3ConnectNativeTestError.clerkSignOutFailed }
        )
        let runtime = EnvironmentRuntime(
            environmentStore: store,
            credentialStore: credentials,
            httpTransport: transport,
            webSocketConnector: T3ConnectBlockingConnector(),
            managedAuthorization: T3ConnectRuntimeAuthorization(controller: controller)
        )
        let client = NativeFeatureClient(
            runtime: runtime,
            t3ConnectController: controller
        )

        await client.signOutT3Connect()

        let remainingEnvironments = try await runtime.environments()
        let activeEnvironmentID = try await store.activeEnvironmentID()
        let remainingManualCredential = await credentials.credential(for: manual.id)
        let remainingManagedCredential = await credentials.credential(for: managed.id)
        XCTAssertEqual(remainingEnvironments, [manual])
        XCTAssertEqual(activeEnvironmentID, manual.id)
        XCTAssertEqual(remainingManualCredential, manualCredential)
        XCTAssertNil(remainingManagedCredential)
        XCTAssertEqual(
            controller.errorMessage,
            T3ConnectNativeTestError.clerkSignOutFailed.localizedDescription
        )
    }

    func testInjectedManagedRuntimeRequiresItsMatchingController() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-connect-controller-mismatch-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let signer = try testSigner()
        let transport = T3ConnectNativeHTTPTransport(descriptorEnvironmentID: "managed-1")
        let runtimeController = T3ConnectController(
            resolution: .unavailable(reason: "Authentication is injected by this test."),
            transport: transport,
            signer: signer
        )
        let runtime = EnvironmentRuntime(
            environmentStore: EnvironmentStore(
                fileURL: directory.appendingPathComponent("environments.json")
            ),
            credentialStore: InMemoryCredentialStore(),
            httpTransport: transport,
            webSocketConnector: T3ConnectBlockingConnector(),
            managedAuthorization: T3ConnectRuntimeAuthorization(controller: runtimeController)
        )
        let client = NativeFeatureClient(runtime: runtime)

        XCTAssertEqual(
            client.t3ConnectController.unavailableReason,
            "This client runtime requires its matching T3 Connect controller."
        )
        do {
            try await client.connectT3Environment(
                try await bootstrapCredential(signer: signer)
            )
            XCTFail("A managed runtime accepted an unrelated controller")
        } catch let error as T3ConnectRelayError {
            guard case .invalidConfiguration = error else {
                return XCTFail("Unexpected T3 Connect error: \(error)")
            }
        }
        let requests = await transport.requests
        XCTAssertTrue(requests.isEmpty)
    }

    private func testSigner() throws -> T3ConnectDPoPSigner {
        var scalar = Data(repeating: 0, count: 32)
        scalar[31] = 11
        return try T3ConnectDPoPSigner(privateKeyRawRepresentation: scalar)
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
            bootstrapExpiresAt: "2030-08-01T12:00:00.000Z",
            proofKeyThumbprint: try await signer.thumbprint()
        )
    }
}

private actor T3ConnectNativeHTTPTransport: HTTPTransport {
    private let descriptorEnvironmentID: String
    private(set) var requests: [URLRequest] = []

    init(descriptorEnvironmentID: String) {
        self.descriptorEnvironmentID = descriptorEnvironmentID
    }

    func data(for request: URLRequest) throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        let body: Data
        switch request.url?.path {
        case "/.well-known/t3/environment":
            body = Data(
                """
                {
                  "environmentId": "\(descriptorEnvironmentID)",
                  "label": "Managed Studio",
                  "platform": {"os": "darwin", "arch": "arm64"},
                  "serverVersion": "1.0.0",
                  "capabilities": {"repositoryIdentity": true}
                }
                """.utf8
            )
        case "/oauth/token":
            body = Data(
                """
                {
                  "access_token": "native-access-token",
                  "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
                  "token_type": "DPoP",
                  "expires_in": 300,
                  "scope": "orchestration:read orchestration:operate terminal:operate review:write relay:read"
                }
                """.utf8
            )
        case "/api/orchestration/shell":
            body = Data(
                #"{"snapshotSequence":1,"projects":[],"threads":[],"updatedAt":"2026-08-01T12:00:00.000Z"}"#.utf8
            )
        case "/api/auth/websocket-ticket":
            body = Data(
                #"{"ticket":"ws-ticket","expiresAt":"2026-08-01T12:05:00.000Z"}"#.utf8
            )
        default:
            throw T3ConnectNativeTestError.unexpectedPath(request.url?.path)
        }
        return (
            body,
            HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
        )
    }
}

private enum T3ConnectNativeTestError: Error {
    case unexpectedPath(String?)
    case clerkSignOutFailed
}

private actor T3ConnectBlockingConnector: WebSocketConnecting {
    private let connection = T3ConnectBlockingConnection()

    func connect(to _: URL) -> any WebSocketConnection {
        connection
    }
}

private actor T3ConnectBlockingConnection: WebSocketConnection {
    private var receiveContinuation: CheckedContinuation<Data, Error>?

    func send(_: Data) {}

    func receive() async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            receiveContinuation = continuation
        }
    }

    func close() {
        receiveContinuation?.resume(throwing: CancellationError())
        receiveContinuation = nil
    }
}
