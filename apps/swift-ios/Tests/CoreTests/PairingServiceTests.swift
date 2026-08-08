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
        // Omitting scope accepts the exact grant carried by the one-time link.
        // Requesting administrative scopes consumes ordinary links and then
        // fails with scope_not_granted.
        XCTAssertFalse(form.contains("scope="))
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
