import XCTest
@testable import T3Code

@MainActor
final class PairingServiceTests: XCTestCase {
    func testPairingExchangesTokenAndPersistsSecretSeparately() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-swift-pairing-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let transport = PairingHTTPTransport()
        let credentials = InMemoryCredentialStore()
        let environments = EnvironmentStore(
            fileURL: directory.appendingPathComponent("environments.json")
        )
        let service = PairingService(
            transport: transport,
            environmentStore: environments,
            credentialStore: credentials
        )

        let environment = try await service.pair(
            url: "https://studio.example/#token=pair-once",
            label: "Theo's iPhone"
        )

        XCTAssertEqual(environment.id, "environment-1")
        let storedEnvironments = try await environments.load()
        let activeID = try await environments.activeEnvironmentID()
        let credential = await credentials.credential(for: "environment-1")
        XCTAssertEqual(storedEnvironments.map(\.id), ["environment-1"])
        XCTAssertEqual(activeID, "environment-1")
        XCTAssertEqual(credential?.accessToken, "access-token")

        let requests = await transport.requests
        XCTAssertEqual(requests.map { $0.url?.path }, [
            "/.well-known/t3/environment",
            "/oauth/token",
        ])
        let form = String(data: requests[1].httpBody!, encoding: .utf8)!
        XCTAssertTrue(form.contains("subject_token=pair-once"))
        XCTAssertTrue(form.contains("client_device_type=mobile"))
        XCTAssertTrue(form.contains("client_surface=mobile"))
        XCTAssertTrue(form.contains("client_app_version="))
        // Omitting scope accepts the exact grant carried by the one-time link.
        // Requesting administrative scopes consumes ordinary links and then
        // fails with scope_not_granted.
        XCTAssertFalse(form.contains("scope="))
    }

    func testFailedRepairRestoresTheExistingCredential() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-swift-pairing-rollback-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.setAttributes(
                [.posixPermissions: NSNumber(value: Int16(0o700))],
                ofItemAtPath: directory.path
            )
            try? FileManager.default.removeItem(at: directory)
        }
        let credentials = InMemoryCredentialStore(credentials: [
            "environment-1": EnvironmentCredential(accessToken: "previous-access-token"),
        ])
        let environments = EnvironmentStore(
            fileURL: directory.appendingPathComponent("environments.json")
        )
        let service = PairingService(
            transport: PairingHTTPTransport(),
            environmentStore: environments,
            credentialStore: credentials
        )
        try FileManager.default.setAttributes(
            [.posixPermissions: NSNumber(value: Int16(0o500))],
            ofItemAtPath: directory.path
        )

        do {
            _ = try await service.pair(
                url: "https://studio.example/#token=pair-once",
                label: "Theo's iPhone"
            )
            XCTFail("Pairing unexpectedly updated a read-only environment catalog")
        } catch {
            let restored = await credentials.credential(for: "environment-1")
            XCTAssertEqual(restored?.accessToken, "previous-access-token")
        }
    }

    func testFailedRepairDoesNotOverwriteNewerCredential() async throws {
        let credentials = InterleavedCredentialStore(
            previousCredential: EnvironmentCredential(accessToken: "previous-access-token"),
            newerCredential: EnvironmentCredential(accessToken: "newer-access-token")
        )

        try await assertFailedPairingPreservesNewerCredential(credentials)
    }

    func testFailedFirstPairingDoesNotDeleteNewerCredential() async throws {
        let credentials = InterleavedCredentialStore(
            previousCredential: nil,
            newerCredential: EnvironmentCredential(accessToken: "newer-access-token")
        )

        try await assertFailedPairingPreservesNewerCredential(credentials)
    }

    func testFailedRepairRestoresCredentialRefreshedBeforeInstallation() async throws {
        let credentials = InterleavedCredentialStore(
            previousCredential: EnvironmentCredential(accessToken: "previous-access-token"),
            newerCredential: EnvironmentCredential(accessToken: "newer-access-token"),
            replacementTiming: .beforeInstallation
        )

        try await assertFailedPairingPreservesNewerCredential(credentials)
    }

    private func assertFailedPairingPreservesNewerCredential(
        _ credentials: InterleavedCredentialStore
    ) async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-swift-pairing-race-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.setAttributes(
                [.posixPermissions: NSNumber(value: Int16(0o700))],
                ofItemAtPath: directory.path
            )
            try? FileManager.default.removeItem(at: directory)
        }
        let service = PairingService(
            transport: PairingHTTPTransport(),
            environmentStore: EnvironmentStore(
                fileURL: directory.appendingPathComponent("environments.json")
            ),
            credentialStore: credentials
        )
        try FileManager.default.setAttributes(
            [.posixPermissions: NSNumber(value: Int16(0o500))],
            ofItemAtPath: directory.path
        )

        do {
            _ = try await service.pair(url: "https://studio.example/#token=pair-once")
            XCTFail("Pairing unexpectedly updated a read-only environment catalog")
        } catch {
            let stored = await credentials.credential(for: "environment-1")
            XCTAssertEqual(stored?.accessToken, "newer-access-token")
        }
    }
}

private actor InterleavedCredentialStore: CredentialStore {
    enum ReplacementTiming {
        case beforeInstallation
        case afterInstallation
    }

    private var storedCredential: EnvironmentCredential?
    private let newerCredential: EnvironmentCredential
    private let replacementTiming: ReplacementTiming
    private var hasInsertedNewerCredential = false

    init(
        previousCredential: EnvironmentCredential?,
        newerCredential: EnvironmentCredential,
        replacementTiming: ReplacementTiming = .afterInstallation
    ) {
        storedCredential = previousCredential
        self.newerCredential = newerCredential
        self.replacementTiming = replacementTiming
    }

    func credential(for environmentID: String) -> EnvironmentCredential? {
        let currentCredential = storedCredential
        if replacementTiming == .beforeInstallation, !hasInsertedNewerCredential {
            hasInsertedNewerCredential = true
            storedCredential = newerCredential
        }
        return currentCredential
    }

    func setCredential(
        _ credential: EnvironmentCredential,
        for environmentID: String
    ) {
        storedCredential = credential
        if replacementTiming == .afterInstallation, !hasInsertedNewerCredential {
            hasInsertedNewerCredential = true
            storedCredential = newerCredential
        }
    }

    func swapCredential(
        _ credential: EnvironmentCredential,
        for environmentID: String
    ) -> EnvironmentCredential? {
        if replacementTiming == .beforeInstallation, !hasInsertedNewerCredential {
            hasInsertedNewerCredential = true
            storedCredential = newerCredential
        }
        let previousCredential = storedCredential
        setCredential(credential, for: environmentID)
        return previousCredential
    }

    func replaceCredential(
        _ credential: EnvironmentCredential,
        ifMatching expected: EnvironmentCredential,
        for environmentID: String
    ) -> Bool {
        guard storedCredential == expected else { return false }
        storedCredential = credential
        return true
    }

    func removeCredential(for environmentID: String) {
        storedCredential = nil
    }

    func removeCredential(
        ifMatching expected: EnvironmentCredential,
        for environmentID: String
    ) -> Bool {
        guard storedCredential == expected else { return false }
        storedCredential = nil
        return true
    }
}

private actor PairingHTTPTransport: HTTPTransport {
    private(set) var requests: [URLRequest] = []

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        let body: String
        switch request.url?.path {
        case "/.well-known/t3/environment":
            body = """
            {
              "environmentId": "environment-1",
              "label": "Studio",
              "platform": {"os": "darwin", "arch": "arm64"},
              "serverVersion": "1.0.0",
              "capabilities": {"repositoryIdentity": true}
            }
            """
        case "/oauth/token":
            body = """
            {
              "access_token": "access-token",
              "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
              "token_type": "Bearer",
              "expires_in": 3600,
              "scope": "orchestration:read orchestration:operate"
            }
            """
        default:
            XCTFail("Unexpected request \(request.url?.absoluteString ?? "")")
            body = "{}"
        }
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        return (Data(body.utf8), response)
    }
}
