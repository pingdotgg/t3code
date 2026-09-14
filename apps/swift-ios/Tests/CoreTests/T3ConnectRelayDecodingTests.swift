import XCTest
@testable import T3Code

final class T3ConnectRelayDecodingTests: XCTestCase {
    func testRelayEnvironmentAndStatusDecodeCurrentContract() throws {
        let environment = try JSONDecoder.t3.decode(
            T3ConnectRelayEnvironment.self,
            from: Data(
                #"{"environmentId":"env-1","label":"Studio","endpoint":{"httpBaseUrl":"https://studio.example","wsBaseUrl":"wss://studio.example","providerKind":"cloudflare_tunnel"},"linkedAt":"2026-08-01T12:00:00.000Z"}"#.utf8
            )
        )
        XCTAssertEqual(environment.id, "env-1")
        XCTAssertEqual(environment.endpoint.providerKind, .cloudflareTunnel)

        let status = try JSONDecoder.t3.decode(
            T3ConnectRelayEnvironmentStatus.self,
            from: Data(
                #"{"environmentId":"env-1","endpoint":{"httpBaseUrl":"https://studio.example","wsBaseUrl":"wss://studio.example","providerKind":"cloudflare_tunnel"},"status":"offline","checkedAt":"2026-08-01T12:01:00.000Z","error":"connector unavailable","traceId":"trace-1"}"#.utf8
            )
        )
        XCTAssertEqual(status.status, .offline)
        XCTAssertEqual(status.error, "connector unavailable")
        XCTAssertEqual(status.traceId, "trace-1")
    }

    func testRelayTokensAndLinkResponsesDecodeSnakeCaseAndOptionalRuntime() throws {
        let token = try JSONDecoder.t3.decode(
            T3ConnectRelayAccessToken.self,
            from: Data(
                #"{"access_token":"relay-token","issued_token_type":"urn:ietf:params:oauth:token-type:access_token","token_type":"DPoP","expires_in":300,"scope":"environment:status environment:connect"}"#.utf8
            )
        )
        XCTAssertEqual(token.accessToken, "relay-token")
        XCTAssertEqual(token.expiresIn, 300)

        let link = try JSONDecoder.t3.decode(
            T3ConnectEnvironmentLinkResponse.self,
            from: Data(
                #"{"ok":true,"cloudUserId":"user-1","environmentId":"env-1","endpoint":{"httpBaseUrl":"https://studio.example","wsBaseUrl":"wss://studio.example","providerKind":"t3_relay"},"endpointRuntime":null,"relayIssuer":"https://relay.example","environmentCredential":"credential","cloudMintPublicKey":"public-key"}"#.utf8
            )
        )
        XCTAssertTrue(link.ok)
        XCTAssertNil(link.endpointRuntime)
        XCTAssertEqual(link.endpoint.providerKind, .t3Relay)
    }

    func testConfirmedDPoPClockFailureHasClockHint() throws {
        let body = try relayErrorBody(
            #"{"code":"auth_invalid","reason":"invalid_dpop","dpopFailureReason":"time_window","traceId":"trace-clock"}"#
        )

        XCTAssertEqual(body.dpopFailureReason, .timeWindow)
        XCTAssertEqual(
            T3ConnectRelayErrorPresentation.message(for: body, requestUsesDPoP: true),
            "Relay rejected the DPoP proof. \(DPoPFailurePresentation.clockHint)"
        )
    }

    func testOlderDPoPFailureTreatsClockSkewAsPossible() throws {
        let body = try relayErrorBody(
            #"{"code":"auth_invalid","reason":"invalid_dpop","traceId":"trace-old"}"#
        )

        XCTAssertNil(body.dpopFailureReason)
        XCTAssertEqual(
            T3ConnectRelayErrorPresentation.message(for: body, requestUsesDPoP: true),
            "Relay rejected the DPoP proof. \(DPoPFailurePresentation.unknownHint)"
        )
    }

    func testNonClockAndUnknownDPoPFailuresUseNeutralHint() throws {
        for reason in ["key_mismatch", "request_mismatch", "token_mismatch", "replay",
                       "invalid_proof", "future_reason"]
        {
            let body = try relayErrorBody(
                #"{"code":"auth_invalid","reason":"invalid_dpop","dpopFailureReason":"\#(reason)","traceId":"trace-retry"}"#
            )
            XCTAssertEqual(
                T3ConnectRelayErrorPresentation.message(for: body, requestUsesDPoP: true),
                "Relay rejected the DPoP proof. \(DPoPFailurePresentation.retryHint)"
            )
        }
    }

    func testMissingEnvironmentLinkUsesSpecificMessage() throws {
        let body = try relayErrorBody(
            #"{"code":"environment_connect_not_authorized","reason":"environment_link_not_found","traceId":"trace-link"}"#
        )

        XCTAssertEqual(
            T3ConnectRelayErrorPresentation.message(for: body, requestUsesDPoP: true),
            "Relay has no active link for this environment. The environment server may not have re-established its link yet."
        )
    }

    func testPresentedRelayErrorPreservesTraceID() throws {
        let body = try relayErrorBody(
            #"{"code":"environment_endpoint_timed_out","traceId":"trace-timeout"}"#
        )
        let error = T3ConnectRelayError.response(
            status: 504,
            message: T3ConnectRelayErrorPresentation.message(
                for: body,
                requestUsesDPoP: true
            ),
            traceID: body.traceId
        )

        XCTAssertEqual(
            error.errorDescription,
            "Relay timed out while contacting the environment endpoint. (trace trace-timeout)"
        )
    }

    func testBearerRelayRequestDoesNotGetDPoPClockAdvice() throws {
        let body = try relayErrorBody(
            #"{"code":"auth_invalid","reason":"invalid_dpop","dpopFailureReason":"time_window","message":"The session was rejected.","traceId":"trace-bearer"}"#
        )

        XCTAssertEqual(
            T3ConnectRelayErrorPresentation.message(for: body, requestUsesDPoP: false),
            "The session was rejected."
        )
    }

    private func relayErrorBody(_ json: String) throws -> T3ConnectRelayErrorBody {
        try JSONDecoder.t3.decode(T3ConnectRelayErrorBody.self, from: Data(json.utf8))
    }
}
