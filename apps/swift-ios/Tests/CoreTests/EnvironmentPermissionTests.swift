import XCTest
@testable import T3Code

final class EnvironmentPermissionTests: XCTestCase {
    func testSessionPermissionPrecedence() throws {
        let cases: [(String, Bool)] = [
            (#"{"authenticated":true,"scopes":["orchestration:operate"]}"#, true),
            (#"{"authenticated":true,"scopes":["orchestration:operate"],"permissions":[]}"#, false),
            (#"{"authenticated":true,"scopes":[],"permissions":["environment:maintain"]}"#, true),
            (#"{"authenticated":false,"permissions":["environment:maintain"]}"#, false),
            (#"{"authenticated":true,"scopes":["orchestration:operate"],"auth":{"serverUpdateScope":"environment:maintain"}}"#, false),
            (#"{"authenticated":true,"scopes":["environment:maintain"],"auth":{"serverUpdateScope":"environment:maintain"}}"#, true),
        ]
        for (wire, expected) in cases {
            let session = try JSONDecoder.t3.decode(AuthSessionState.self, from: Data(wire.utf8))
            let state = EnvironmentPermissionState(session: session)
            XCTAssertEqual(state.grants("environment:maintain"), expected, wire)
            if expected {
                XCTAssertNoThrow(try state.require("environment:maintain"))
            } else {
                XCTAssertThrowsError(try state.require("environment:maintain")) { error in
                    let denial = error as? EnvironmentPermissionDeniedError
                    XCTAssertEqual(denial?.requiredPermission, "environment:maintain")
                    XCTAssertEqual(denial?.requiredScope, "orchestration:operate")
                    XCTAssertFalse(error.isRejectedAuthorization)
                }
            }
        }
    }

    func testCachedMetadataAndUnknownGrantsStayExact() throws {
        let oldSession = AuthSessionState(authenticated: true, scopes: ["orchestration:operate"])
        let currentServer = EnvironmentPermissionState(
            session: oldSession, serverAuth: .init(serverUpdateScope: "environment:maintain")
        )
        XCTAssertFalse(currentServer.grants("settings:write"))
        XCTAssertFalse(EnvironmentPermissionState().grants("orchestration:read"))
        let narrow = EnvironmentPermissionState(session: .init(
            authenticated: true, permissions: ["providers:manage", "future:permission"]
        ))
        XCTAssertNoThrow(try narrow.require("providers:manage"))
        XCTAssertTrue(narrow.grants("future:permission"))
        XCTAssertFalse(narrow.grants("orchestration:operate"))
        XCTAssertEqual(try JSONDecoder.t3.decode(
            EnvironmentPermissionState.self, from: JSONEncoder.t3.encode(narrow)
        ), narrow)
    }

    func testLegacyNoticeOnlyTargetsCurrentServersReportingOldGrants() {
        XCTAssertFalse(AuthSessionState(authenticated: true, scopes: ["orchestration:operate"]).hasLegacyPermissions)
        XCTAssertTrue(AuthSessionState(authenticated: true, permissions: ["orchestration:read", "review:write"]).hasLegacyPermissions)
        XCTAssertFalse(AuthSessionState(authenticated: false, permissions: ["orchestration:read"]).hasLegacyPermissions)
        XCTAssertFalse(AuthSessionState(authenticated: true, permissions: []).hasLegacyPermissions)
        XCTAssertFalse(AuthSessionState(authenticated: true, permissions: ["orchestration:read", "filesystem:read"]).hasLegacyPermissions)
        XCTAssertFalse(AuthSessionState(authenticated: true, permissions: ["access:read"]).hasLegacyPermissions)
    }

    func testSettingsDomainsAndAssetKindsRequireTheirOwnPermissions() {
        XCTAssertEqual(EnvironmentPermissionRequirements.settingsPatch([:]), ["settings:write"])
        XCTAssertEqual(EnvironmentPermissionRequirements.settingsPatch(["providers": .object([:])]), ["settings:write", "providers:manage"])
        XCTAssertEqual(EnvironmentPermissionRequirements.settingsPatch([
            "providers": .object([:]), "removeAgentCreditsOnMerge": .bool(true),
        ]), ["settings:write", "providers:manage"])
        for kind in ["workspace-file", "media-file", "draft-workspace-file"] {
            XCTAssertEqual(EnvironmentPermissionRequirements.asset(resourceKind: kind), "filesystem:read")
        }
        XCTAssertEqual(EnvironmentPermissionRequirements.asset(resourceKind: "attachment"), "orchestration:read")
    }

    func testRPCPermissionDenialKeepsTypedMetadataAndSocketUsable() async throws {
        let connection = PermissionDenialConnection()
        let client = WebSocketRPCClient(
            connector: PermissionDenialConnector(connection: connection),
            endpointProvider: { URL(string: "wss://example.test/ws")! }
        )
        do {
            _ = try await client.request("server.update", as: JSONValue.self)
            XCTFail("Expected a permission denial")
        } catch let denial as EnvironmentPermissionDeniedError {
            XCTAssertEqual(denial.requiredScope, "orchestration:operate")
            XCTAssertEqual(denial.requiredPermission, "environment:maintain")
            XCTAssertFalse(denial.isRejectedAuthorization)
        }
        let response = try await client.request("server.read", as: JSONValue.self)
        XCTAssertEqual(response, .bool(true))
        let count = await connection.requestCount
        XCTAssertEqual(count, 2)
        await client.stop()
    }
}

private struct PermissionDenialConnector: WebSocketConnecting {
    let connection: PermissionDenialConnection
    func connect(to url: URL) async throws -> any WebSocketConnection { connection }
}

private actor PermissionDenialConnection: WebSocketConnection {
    private var queued: [Data] = []
    private var waiter: CheckedContinuation<Data, Error>?
    private(set) var requestCount = 0

    func send(_ data: Data) throws {
        let request = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        guard case let .number(id) = request["id"] else { return }
        requestCount += 1
        let exit: JSONValue = requestCount == 1 ? .object([
            "_tag": .string("Failure"),
            "cause": .array([.object([
                "_tag": .string("Fail"),
                "error": .object([
                    "_tag": .string("EnvironmentAuthorizationError"),
                    "message": .string("Permission required"),
                    "requiredScope": .string("orchestration:operate"),
                    "requiredPermission": .string("environment:maintain"),
                ]),
            ])]),
        ]) : .object(["_tag": .string("Success"), "value": .bool(true)])
        let response = try JSONEncoder.t3.encode(JSONValue.object([
            "_tag": .string("Exit"), "requestId": .number(id), "exit": exit,
        ]))
        if let waiter {
            self.waiter = nil
            waiter.resume(returning: response)
        } else {
            queued.append(response)
        }
    }

    func receive() async throws -> Data {
        if !queued.isEmpty { return queued.removeFirst() }
        return try await withCheckedThrowingContinuation { waiter = $0 }
    }

    func close() {
        waiter?.resume(throwing: CancellationError())
        waiter = nil
    }
}
