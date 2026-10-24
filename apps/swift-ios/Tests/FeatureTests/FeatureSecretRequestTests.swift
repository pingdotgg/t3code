import Foundation
import XCTest
@testable import T3Code

@MainActor
final class FeatureSecretRequestTests: XCTestCase {
    func testOnlyLocalPendingRequestIsActionable() async throws {
        for visibility in ["local", "inherited", "synthetic"] {
            let item = try request(visibility: visibility)
            XCTAssertEqual(FeatureSecretRequestDisplay.display(item) == .pending, visibility == "local")
            let controller = FeatureSecretRequestController()
            let client = SecretAnswerClient()
            let task = controller.submit(.decline, item: item, context: .init(threadID: "scoped-thread", client: client))
            XCTAssertEqual(task != nil, visibility == "local")
            await task?.value
        }
        for status in ["saved", "declined", "cancelled"] {
            XCTAssertNotEqual(FeatureSecretRequestDisplay.display(try request(status: status)), .pending)
        }
    }

    func testDeniedAndUnknownContextsClearInputAndCannotSubmit() throws {
        let client = SecretAnswerClient()
        let controller = FeatureSecretRequestController()
        let permissions: [Bool?] = [false, nil]
        for canAnswer in permissions {
            let context = FeatureSecretRequestContext(threadID: "scoped-thread", client: client, canAnswer: canAnswer)
            controller.value = "private-sentinel"
            XCTAssertNil(controller.submit(.save(controller.value), item: try request(), context: context))
            XCTAssertEqual(controller.value, "")
            XCTAssertNil(controller.submit(.decline, item: try request(), context: context))
        }
        XCTAssertTrue(client.calls.isEmpty)
    }

    func testWireSecretFailuresUseAllowlistedReasonsWithoutAMessage() async throws {
        let reasons = [
            ("load_failed", "Could not load the secret request."),
            ("not_found", "This secret request no longer exists."),
            ("already_answered", "This secret request was already answered."),
            ("agent_stopped", "The agent that asked has stopped, so this secret can't be used."),
            ("store_failed", "Could not store the secret."),
            ("record_failed", "Saved the secret, but could not update the request."),
        ]
        var cases: [(JSONValue, String)] = reasons.map { reason, message in
            (.object(["_tag": .string("SecretRequestError"), "reason": .string(reason)]), message)
        }
        for reason in ["already_answered", "private-sentinel"] {
            cases.append((.object([
                "_tag": .string("SecretRequestError"), "reason": .string(reason),
                "message": .string("private-sentinel"), "detail": .string("private-sentinel"),
                "cause": .object(["message": .string("private-sentinel")]),
            ]), reason == "already_answered" ? "This secret request was already answered." : SecretRequestFailure.generic))
        }
        cases.append((.object([
            "_tag": .string("SecretRequestError"), "message": .string("private-sentinel"),
        ]), SecretRequestFailure.generic))

        for (failure, expected) in cases {
            let connection = SecretFailureConnection(failure: failure)
            let rpc = WebSocketRPCClient(
                connector: SecretFailureConnector(connection: connection),
                endpointProvider: { URL(string: "wss://example.test/ws")! }
            )
            do {
                try await rpc.request(RPCMethod.secretsAnswerRequest.rawValue, payload: .object([
                    "threadId": .string("thread"), "turnItemId": .string("secret"),
                    "answer": .object(["type": .string("save"), "secret": .string("private-sentinel")]),
                ]))
                XCTFail("Expected a secret request failure")
            } catch {
                XCTAssertEqual((error as? RPCError)?.remoteMessage, expected)
                XCTAssertEqual(SecretRequestSafeError(error).message, expected)
                XCTAssertFalse(SecretRequestFailure.message(error).contains("private-sentinel"))
            }
            await rpc.stop()
        }
    }

    func testBlankAnswerDoesNothingAndSynchronousGuardAllowsOneSubmission() async throws {
        let item = try request()
        let client = SecretAnswerClient()
        let context = FeatureSecretRequestContext(threadID: "scoped-thread", client: client)
        let controller = FeatureSecretRequestController()
        XCTAssertNil(controller.submit(.save(" \n "), item: item, context: context))
        controller.value = "  private-value \n"
        let task = try XCTUnwrap(controller.submit(.save(controller.value), item: item, context: context))
        XCTAssertTrue(controller.isSending)
        XCTAssertNil(controller.submit(.decline, item: item, context: context))
        await task.value
        XCTAssertEqual(client.calls.count, 1)
        XCTAssertEqual(client.calls[0].threadID, "scoped-thread")
        XCTAssertEqual(client.calls[0].source.sourceThreadID, "thread")
        XCTAssertEqual(client.calls[0].payload, .object(["type": .string("save"), "secret": .string("private-value")]))
        XCTAssertEqual(controller.value, "")
        XCTAssertFalse(controller.isSending)
        XCTAssertTrue(controller.submitted)
    }

    func testDeclineHasNoSecretAndUnknownErrorsNeverEchoInput() async throws {
        let item = try request()
        let client = SecretAnswerClient()
        client.failure = RPCError.remote("Transport echoed private-sentinel")
        let controller = FeatureSecretRequestController()
        controller.value = "private-sentinel"
        let task = try XCTUnwrap(controller.submit(.decline, item: item, context: .init(threadID: "scoped-thread", client: client)))
        await task.value
        XCTAssertEqual(client.calls.first?.payload, .object(["type": .string("decline")]))
        XCTAssertEqual(controller.errorMessage, SecretRequestFailure.generic)
        XCTAssertFalse(controller.errorMessage?.contains("private-sentinel") ?? true)
        XCTAssertEqual(SecretRequestFailure.message(RPCError.remote("This secret request was already answered.")), "This secret request was already answered.")
        XCTAssertEqual(SecretRequestFailure.message(RPCError.remoteDefect("This secret request was already answered.")), SecretRequestFailure.generic)
        controller.clear()
        XCTAssertEqual(controller.value, "")
        XCTAssertNil(controller.errorMessage)
    }

    func testAuthoritativeStatusClearsInputAndIgnoresOldCompletion() async throws {
        let client = SecretAnswerClient()
        client.shouldWait = true
        let began = expectation(description: "Direct request started")
        client.began = { began.fulfill() }
        let controller = FeatureSecretRequestController()
        controller.value = "private-sentinel"
        let task = try XCTUnwrap(controller.submit(.save(controller.value), item: try request(), context: .init(threadID: "scoped-thread", client: client)))
        await fulfillment(of: [began], timeout: 1)
        controller.clear()
        client.finish()
        await task.value
        XCTAssertEqual(controller.value, "")
        XCTAssertFalse(controller.submitted)
        XCTAssertFalse(controller.isSending)
        XCTAssertNil(controller.errorMessage)
    }

    func testPermissionLossClearsInputAndIgnoresOldFailure() async throws {
        let permissions: [Bool?] = [false, nil]
        for canAnswer in permissions {
            let client = SecretAnswerClient()
            client.shouldWait = true
            client.failure = RPCError.remote("This secret request was already answered.")
            let began = expectation(description: "Direct request started")
            client.began = { began.fulfill() }
            let controller = FeatureSecretRequestController()
            controller.value = "private-sentinel"
            controller.updatePermission(true)
            XCTAssertEqual(controller.value, "private-sentinel")
            let context = FeatureSecretRequestContext(threadID: "scoped-thread", client: client)
            let task = try XCTUnwrap(controller.submit(.save(controller.value), item: try request(), context: context))
            await fulfillment(of: [began], timeout: 1)
            controller.updatePermission(canAnswer)
            XCTAssertEqual(controller.value, "")
            XCTAssertFalse(controller.isSending)
            client.finish()
            await task.value
            XCTAssertFalse(controller.submitted)
            XCTAssertNil(controller.errorMessage)
            controller.updatePermission(true)
            client.shouldWait = false
            client.failure = nil
            let retry = try XCTUnwrap(controller.submit(.decline, item: try request(), context: context))
            await retry.value
            XCTAssertTrue(controller.submitted)
        }
    }

    func testGenericCopyIncludesMetadataOnlyEvenIfUnknownFieldsContainInput() throws {
        let raw = V2Fixture.patch(try request().raw, [
            "secret": .string("private-sentinel"), "input": .string("private-sentinel"),
            "output": .string("private-sentinel"), "secretRef": .string("private-sentinel"),
        ])
        XCTAssertEqual(FeatureV2ItemDetail.copyText(raw), "API key\nConnect the service\npending")
        XCTAssertFalse(FeatureV2FormattedItem(raw: raw).copyText.contains("private-sentinel"))
    }

    private func request(status: String = "pending", visibility: String = "local") throws -> FeatureV2WorkItem {
        let raw = V2Fixture.item("secret", type: "secret_request", ordinal: 1, fields: [
            "label": .string("API key"), "reason": .string("Connect the service"), "secretStatus": .string(status),
        ])
        let item = try OrchestrationV2TurnItem(json: raw)
        let row = OrchestrationV2ProjectedTurnItem(position: 0, visibility: visibility, sourceThreadId: "thread", sourceItemId: "secret", item: item)
        return FeatureV2WorkItem(source: .init(row), raw: raw)
    }
}

@MainActor
private final class SecretAnswerClient: FeatureSecretRequestAnswering {
    struct Call { let threadID: String; let source: OrchestrationV2TimelineMetadata; let payload: JSONValue? }
    var calls: [Call] = []
    var failure: (any Error)?
    var shouldWait = false
    var began: (() -> Void)?
    private var continuation: CheckedContinuation<Void, Never>?

    func answerSecretRequest(threadID: String, source: OrchestrationV2TimelineMetadata, answer: SecretRequestAnswer) async throws {
        calls.append(Call(threadID: threadID, source: source, payload: answer.payload))
        if shouldWait {
            await withCheckedContinuation { continuation in
                self.continuation = continuation
                began?()
            }
        }
        if let failure { throw failure }
    }

    func finish() { continuation?.resume(); continuation = nil }
}

private struct SecretFailureConnector: WebSocketConnecting {
    let connection: SecretFailureConnection
    func connect(to url: URL) async throws -> any WebSocketConnection { connection }
}

private actor SecretFailureConnection: WebSocketConnection {
    let failure: JSONValue
    private var queued: [Data] = []
    private var waiter: CheckedContinuation<Data, Error>?

    init(failure: JSONValue) { self.failure = failure }

    func send(_ data: Data) throws {
        let request = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        guard case let .number(id) = request["id"] else { return }
        let response = try JSONEncoder.t3.encode(JSONValue.object([
            "_tag": .string("Exit"), "requestId": .number(id),
            "exit": .object([
                "_tag": .string("Failure"),
                "cause": .array([.object(["_tag": .string("Fail"), "error": failure])]),
            ]),
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
