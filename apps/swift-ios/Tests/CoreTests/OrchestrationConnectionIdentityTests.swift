import Foundation
import Testing
@testable import T3Code

@Suite("Orchestration descriptor identity")
struct OrchestrationConnectionIdentityTests {
    @Test(arguments: [1, 2])
    func mismatchedDescriptorRejectsShellReadBeforeCredentialAccess(version: Int) async throws {
        let transport = IdentityDescriptorTransport(environmentID: "another-environment", version: version)
        let credentials = IdentityCredentialSpy()
        let client = T3Client(environment: environment, credentialStore: credentials, httpTransport: transport)

        await #expect(throws: EnvironmentRouteError.identityMismatch) {
            _ = try await client.shellSnapshot()
        }

        #expect(await credentials.reads == [])
        let requests = await transport.requests
        #expect(requests.map { $0.url?.path } == ["/.well-known/t3/environment"])
        #expect(requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == nil })
    }

    @Test
    func mismatchedRefreshInvalidatesThePreviouslyAcceptedDescriptor() async throws {
        let transport = IdentityDescriptorTransport(environmentID: environment.id, version: 2)
        let credentials = IdentityCredentialSpy()
        let connection = OrchestrationConnection(
            environment: environment,
            api: EnvironmentAPI(transport: transport, credentials: credentials)
        )
        let accepted = try await connection.selection()
        #expect(accepted.version == .v2)

        await transport.setEnvironmentID("another-environment")
        await #expect(throws: EnvironmentRouteError.identityMismatch) {
            _ = try await connection.selection(refresh: true)
        }
        await #expect(throws: EnvironmentRouteError.identityMismatch) {
            _ = try await connection.selection()
        }

        await transport.setEnvironmentID(environment.id)
        let recovered = try await connection.selection()
        #expect(recovered.descriptor.environmentId == environment.id)
        #expect(recovered.version == accepted.version)
        #expect(recovered.generation == accepted.generation)
        #expect(await transport.requests.count == 4)
        #expect(await credentials.reads == [])
    }

    private var environment: Environment {
        Environment(
            id: "expected-environment", label: "Expected environment",
            httpBaseURL: URL(string: "https://identity.example")!,
            webSocketBaseURL: URL(string: "wss://identity.example/ws")!
        )
    }
}

private actor IdentityDescriptorTransport: HTTPTransport {
    private var environmentID: String
    private let version: Int
    private(set) var requests: [URLRequest] = []

    init(environmentID: String, version: Int) {
        self.environmentID = environmentID
        self.version = version
    }

    func setEnvironmentID(_ id: String) { environmentID = id }

    func data(for request: URLRequest) throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        let url = try #require(request.url)
        guard url.path == "/.well-known/t3/environment" else { throw URLError(.unsupportedURL) }
        let descriptor: JSONValue = .object([
            "environmentId": .string(environmentID), "label": .string("Descriptor fixture"),
            "platform": .object(["os": .string("darwin"), "arch": .string("arm64")]),
            "serverVersion": .string("fixture"), "capabilities": .object([:]),
            "orchestrationProtocolVersion": .number(Double(version)),
        ])
        return (try JSONEncoder.t3.encode(descriptor), try #require(HTTPURLResponse(
            url: url, statusCode: 200, httpVersion: nil, headerFields: nil
        )))
    }
}

private actor IdentityCredentialSpy: CredentialStore {
    private(set) var reads: [String] = []

    func credential(for environmentID: String) -> EnvironmentCredential? {
        reads.append(environmentID)
        return .init(accessToken: "must-not-be-read")
    }

    func setCredential(_ credential: EnvironmentCredential, for environmentID: String) throws {
        throw CredentialStoreError.invalidData
    }

    func swapCredential(_ credential: EnvironmentCredential, for environmentID: String) throws -> EnvironmentCredential? {
        throw CredentialStoreError.invalidData
    }

    func replaceCredential(
        _ credential: EnvironmentCredential, ifMatching expected: EnvironmentCredential?, for environmentID: String
    ) throws -> Bool {
        throw CredentialStoreError.invalidData
    }

    func removeCredential(for environmentID: String) throws {
        throw CredentialStoreError.invalidData
    }

    func removeCredential(ifMatching expected: EnvironmentCredential, for environmentID: String) throws -> Bool {
        throw CredentialStoreError.invalidData
    }
}
