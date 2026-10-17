import Foundation
import XCTest
@testable import T3Code

final class T3ConnectRelayParityTests: XCTestCase {
    private let traceID = "4684d7d140f34f0393d42744d240e207"
    private let traceparent = "00-4684d7d140f34f0393d42744d240e207-0baf648c44f4bce6-01"

    func testTunnelSetupIsTransientAndRetryKeepsCachedAuthorization() async throws {
        let transport = RelayParityTransport { _, ordinal in
            switch ordinal {
            case 1: return .token
            case 2:
                return .init(status: 403, body: #"{"code":"environment_connect_not_authorized","reason":"managed_endpoint_allocation_not_ready","traceId":"allocation-trace"}"#)
            default:
                return .init(status: 200, body: #"{"environmentId":"env-1","endpoint":{"httpBaseUrl":"https://managed.example","wsBaseUrl":"wss://managed.example","providerKind":"t3_relay"},"credential":"bootstrap-secret","expiresAt":"2026-10-16T12:00:00Z"}"#)
            }
        }
        let relay = try relay(transport)
        do {
            _ = try await relay.connect(to: environment, clerkToken: "clerk-secret")
            XCTFail("Tunnel setup must remain retryable")
        } catch let error as T3ConnectRelayError {
            guard case let .connectionNotAuthorized(reason, traceID) = error else { throw error }
            XCTAssertEqual(reason, "managed_endpoint_allocation_not_ready")
            XCTAssertEqual(traceID, "allocation-trace")
            XCTAssertTrue(error.isTransient)
            XCTAssertEqual(error.localizedDescription,
                           "The environment's T3 Connect tunnel is still being set up. (trace allocation-trace)")
        }

        let credential = try await relay.connect(to: environment, clerkToken: "clerk-secret")
        XCTAssertEqual(credential.environmentID, "env-1")
        let requests = await transport.requests
        XCTAssertEqual(requests.count, 3)
        XCTAssertEqual(requests.filter { $0.url?.path == "/v1/client/dpop-token" }.count, 1)
        XCTAssertEqual(requests[1].value(forHTTPHeaderField: "Authorization"), "DPoP relay-secret")
        XCTAssertEqual(requests[2].value(forHTTPHeaderField: "Authorization"), "DPoP relay-secret")
        XCTAssertNotEqual(requests[1].value(forHTTPHeaderField: "DPoP"),
                          requests[2].value(forHTTPHeaderField: "DPoP"))
    }

    func testOtherConnectionRefusalsStayBlockedWithoutRefreshingAuthorization() async throws {
        for reason in ["environment_link_not_found", "endpoint_provider_not_managed",
                       "managed_endpoint_allocation_not_found", "managed_endpoint_mismatch", "future_reason"] {
            let transport = RelayParityTransport { _, ordinal in
                ordinal == 1 ? .token : .init(status: 403, body: """
                {"code":"environment_connect_not_authorized","reason":"\(reason)","traceId":"denied-trace"}
                """)
            }
            do {
                _ = try await relay(transport).connect(to: environment, clerkToken: "clerk-secret")
                XCTFail("Connection refusal was ignored")
            } catch let error as T3ConnectRelayError {
                guard case let .connectionNotAuthorized(actualReason, traceID) = error else { throw error }
                XCTAssertEqual(actualReason, reason)
                XCTAssertEqual(traceID, "denied-trace")
                XCTAssertFalse(error.isTransient)
            }
            let requests = await transport.requests
            XCTAssertEqual(requests.count, 2)
        }
    }

    func testUntypedGatewayTimeoutUsesActionableCopyAndHeaderTraceWithoutBodyLeaks() async throws {
        for body in ["<html>gateway-secret</html>", "{}",
                     #"{"message":"gateway-secret","traceId":"untrusted-body-trace"}"#,
                     #"{"code":"future_code","message":"gateway-secret"}"#] {
            let header = traceparent
            let transport = RelayParityTransport { _, _ in
                .init(status: 504, body: body, headers: ["Traceparent": header])
            }
            do {
                _ = try await relay(transport).listEnvironments(clerkToken: "clerk-secret")
                XCTFail("Gateway timeout was ignored")
            } catch let error as T3ConnectRelayError {
                guard case let .unexpectedResponse(status, actualTraceID) = error else { throw error }
                XCTAssertEqual(status, 504)
                XCTAssertEqual(actualTraceID, traceID)
                XCTAssertTrue(error.isTransient)
                XCTAssertEqual(error.localizedDescription,
                               "Relay timed out before it finished the request (HTTP 504). Try again in a few minutes. If it keeps failing, copy the trace ID when you report it. (trace \(traceID))")
                XCTAssertFalse(String(reflecting: error).contains("gateway-secret"))
                XCTAssertFalse(error.localizedDescription.contains("clerk-secret"))
                XCTAssertFalse(error.localizedDescription.contains("untrusted-body-trace"))
            }
        }
    }

    func testUnexpectedStatusUsesHTTPNumberAndOnlyValidTraceparentTraceID() async throws {
        let headers: [String?] = [nil, "invalid-secret", traceID,
                                 traceparent + "-extra", traceparent + "\n", traceparent.uppercased()]
        for header in headers {
            let transport = RelayParityTransport { _, _ in
                .init(status: 502, body: "gateway-secret", headers: header.map { ["traceparent": $0] } ?? [:])
            }
            do {
                _ = try await relay(transport).listEnvironments(clerkToken: "clerk-secret")
                XCTFail("Unexpected status was ignored")
            } catch let error as T3ConnectRelayError {
                guard case let .unexpectedResponse(status, actualTraceID) = error else { throw error }
                XCTAssertEqual(status, 502)
                let expectedTraceID = header == traceparent.uppercased() ? traceID.uppercased() : nil
                XCTAssertEqual(actualTraceID, expectedTraceID)
                XCTAssertEqual(error.localizedDescription, expectedTraceID.map {
                    "Relay returned an unexpected HTTP 502. (trace \($0))"
                } ?? "Relay returned an unexpected HTTP 502.")
                XCTAssertFalse(String(reflecting: error).contains("secret"))
            }
        }
    }

    func testTypedEndpointTimeoutKeepsSpecificCopyAndBodyTrace() async throws {
        let header = traceparent
        let transport = RelayParityTransport { _, _ in
            .init(status: 504,
                  body: #"{"code":"environment_endpoint_timed_out","traceId":"endpoint-trace"}"#,
                  headers: ["traceparent": header])
        }
        do {
            _ = try await relay(transport).listEnvironments(clerkToken: "clerk-secret")
            XCTFail("Typed timeout was ignored")
        } catch let error as T3ConnectRelayError {
            guard case let .response(status, message, traceID) = error else { throw error }
            XCTAssertEqual(status, 504)
            XCTAssertEqual(message, "Relay timed out while contacting the environment endpoint.")
            XCTAssertEqual(traceID, "endpoint-trace")
            XCTAssertTrue(error.isTransient)
        }
    }

    func testRejectedRelayTokenRefreshesOnlyOnceWithFreshProof() async throws {
        let transport = RelayParityTransport { _, ordinal in
            switch ordinal {
            case 1, 3: return .token
            default:
                return .init(status: 401, body: #"{"code":"auth_invalid","reason":"invalid_bearer","traceId":"auth-trace"}"#)
            }
        }
        do {
            _ = try await relay(transport).connect(to: environment, clerkToken: "clerk-secret")
            XCTFail("A second token rejection must escape the refresh attempt")
        } catch let error as T3ConnectRelayError {
            guard case let .response(status, message, traceID) = error else { throw error }
            XCTAssertEqual(status, 401)
            XCTAssertEqual(message, "Relay rejected the cloud session token.")
            XCTAssertEqual(traceID, "auth-trace")
            XCTAssertFalse(error.isTransient)
            XCTAssertFalse(String(reflecting: error).contains("secret"))
        }
        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.url?.path), ["/v1/client/dpop-token", "/v1/environments/env-1/connect",
                                                  "/v1/client/dpop-token", "/v1/environments/env-1/connect"])
        XCTAssertNotEqual(requests[1].value(forHTTPHeaderField: "DPoP"),
                          requests[3].value(forHTTPHeaderField: "DPoP"))
    }

    func testManagedAuthorizerPreservesTypedPermissionDenial() async throws {
        let transport = RelayParityTransport { _, _ in
            .init(status: 403, body: #"{"message":"Access denied","requiredScope":"orchestration:read","requiredPermission":"threads:read","traceId":"permission-trace"}"#)
        }
        let signer = try signer()
        let authorizer = T3ConnectManagedEnvironmentAuthorizer(transport: transport, signer: signer)
        let authorization = T3ConnectEnvironmentAccessToken(
            environmentID: "env-1", label: "Studio", endpoint: environment.endpoint,
            accessToken: "environment-secret", expiresAt: .distantFuture,
            scopes: ["orchestration:read"], proofKeyThumbprint: try await signer.thumbprint()
        )
        do {
            _ = try await authorizer.webSocketURL(using: authorization)
            XCTFail("Permission denial was ignored")
        } catch let error as EnvironmentPermissionDeniedError {
            XCTAssertEqual(error.requiredScope, "orchestration:read")
            XCTAssertEqual(error.requiredPermission, "threads:read")
            XCTAssertEqual(error.traceID, "permission-trace")
            XCTAssertFalse(error.localizedDescription.contains("environment-secret"))
        }
        let requests = await transport.requests
        XCTAssertEqual(requests.count, 1)
    }

    func testUntyped401StillRefreshesAuthorizationOnlyOnce() async throws {
        let transport = RelayParityTransport { _, ordinal in
            ordinal == 1 || ordinal == 3 ? .token : .init(status: 401, body: "gateway-secret")
        }
        do {
            _ = try await relay(transport).connect(to: environment, clerkToken: "clerk-secret")
            XCTFail("A second rejection must escape the refresh attempt")
        } catch let error as T3ConnectRelayError {
            guard case let .unexpectedResponse(status, traceID) = error else { throw error }
            XCTAssertEqual(status, 401)
            XCTAssertNil(traceID)
            XCTAssertFalse(String(reflecting: error).contains("secret"))
        }
        let requests = await transport.requests
        XCTAssertEqual(requests.count, 4)
        XCTAssertEqual(requests.filter { $0.url?.path == "/v1/client/dpop-token" }.count, 2)
    }

    func testManagedAuthorizerUntypedTimeoutKeepsTraceAndActionableCopy() async throws {
        let header = traceparent
        let transport = RelayParityTransport { _, _ in
            .init(status: 504, body: "<html>gateway-secret</html>", headers: ["traceparent": header])
        }
        let authorizer = T3ConnectManagedEnvironmentAuthorizer(transport: transport, signer: try signer())
        do {
            _ = try await authorizer.descriptor(at: URL(string: "https://managed.example")!)
            XCTFail("Gateway timeout was ignored")
        } catch let error as T3ConnectRelayError {
            guard case let .unexpectedResponse(status, actualTraceID) = error else { throw error }
            XCTAssertEqual(status, 504)
            XCTAssertEqual(actualTraceID, traceID)
            XCTAssertTrue(error.localizedDescription.contains("Try again in a few minutes."))
            XCTAssertFalse(String(reflecting: error).contains("gateway-secret"))
        }
    }

    private var environment: T3ConnectRelayEnvironment {
        .init(environmentId: "env-1", label: "Studio",
              endpoint: .init(httpBaseUrl: "https://managed.example", wsBaseUrl: "wss://managed.example",
                              providerKind: .t3Relay),
              linkedAt: "2026-10-16T12:00:00Z")
    }

    private func relay(_ transport: RelayParityTransport) throws -> T3ConnectRelayClient {
        T3ConnectRelayClient(
            configuration: .init(clerkPublishableKey: "pk_test", relayHTTPURL: URL(string: "https://relay.example")!),
            transport: transport, signer: try signer()
        )
    }

    private func signer() throws -> T3ConnectDPoPSigner {
        var scalar = Data(repeating: 0, count: 32)
        scalar[31] = 1
        return try T3ConnectDPoPSigner(privateKeyRawRepresentation: scalar)
    }
}

private actor RelayParityTransport: HTTPTransport {
    struct Reply: Sendable {
        let status: Int
        let body: String
        var headers: [String: String] = [:]

        static let token = Self(status: 200, body: #"{"access_token":"relay-secret","issued_token_type":"urn:ietf:params:oauth:token-type:access_token","token_type":"DPoP","expires_in":300,"scope":"environment:connect"}"#)
    }

    private let reply: @Sendable (URLRequest, Int) throws -> Reply
    private(set) var requests: [URLRequest] = []

    init(reply: @escaping @Sendable (URLRequest, Int) throws -> Reply) {
        self.reply = reply
    }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        let reply = try reply(request, requests.count)
        let response = try XCTUnwrap(HTTPURLResponse(url: XCTUnwrap(request.url), statusCode: reply.status,
                                                   httpVersion: "HTTP/1.1", headerFields: reply.headers))
        return (Data(reply.body.utf8), response)
    }
}
