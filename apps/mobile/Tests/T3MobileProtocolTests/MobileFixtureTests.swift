import Foundation
import T3MobileProtocol
import XCTest

final class MobileFixtureTests: XCTestCase {
    private let decoder = JSONDecoder()

    func testDecodesTypeScriptServerFixtures() throws {
        let descriptor = try decodeFixture(
            "server/descriptor.json",
            as: MobileDescriptorResult.self
        )
        XCTAssertEqual(descriptor.protocolVersion, mobileProtocolVersion)
        XCTAssertEqual(descriptor.endpoints.websocket, "/mobile/v1/ws")
        XCTAssertEqual(descriptor.environment.environmentId, "environment-fixture")

        let hello = try decodeServerMessage("server/hello.json")
        guard case let .hello(helloResponse) = hello else {
            return XCTFail("Expected hello response")
        }
        XCTAssertEqual(helloResponse.id, "hello-1")

        let shell = try decodeServerMessage("server/shell-snapshot.json")
        guard case let .stream(shellStream) = shell else {
            return XCTFail("Expected shell stream")
        }
        XCTAssertEqual(shellStream.payload.kind, "snapshot")
        XCTAssertNotNil(shellStream.payload.snapshot)

        let thread = try decodeServerMessage("server/thread-snapshot.json")
        guard case let .stream(threadStream) = thread else {
            return XCTFail("Expected thread stream")
        }
        XCTAssertEqual(threadStream.payload.kind, "snapshot")
        XCTAssertNotNil(threadStream.payload.snapshot)

        let replay = try decodeServerMessage("server/replay-complete.json")
        guard case let .response(replayResponse) = replay,
              case let .replay(replayEnvelope) = replayResponse.payload
        else {
            return XCTFail("Expected replay response")
        }
        XCTAssertEqual(replayEnvelope.status, "complete")
        XCTAssertEqual(replayEnvelope.returnedToSequenceInclusive, 6)
        XCTAssertEqual(replayEnvelope.events.count, 1)

        let replayGap = try decodeServerMessage("server/replay-gap.json")
        guard case let .response(replayGapResponse) = replayGap,
              case let .replay(replayGapEnvelope) = replayGapResponse.payload
        else {
            return XCTFail("Expected replay gap response")
        }
        XCTAssertEqual(replayGapEnvelope.status, "cursor-too-old")
        XCTAssertEqual(replayGapEnvelope.resnapshot, ["all"])

        let receipt = try decodeServerMessage("server/command-accepted.json")
        guard case let .response(receiptResponse) = receipt,
              case let .commandReceipt(commandReceipt) = receiptResponse.payload
        else {
            return XCTFail("Expected command receipt response")
        }
        XCTAssertEqual(commandReceipt.status, "accepted")
        XCTAssertEqual(commandReceipt.sequence, 7)

        let diff = try decodeServerMessage("server/turn-diff.json")
        guard case let .response(diffResponse) = diff,
              case let .turnDiff(turnDiff) = diffResponse.payload
        else {
            return XCTFail("Expected turn diff response")
        }
        XCTAssertEqual(turnDiff.diff, "diff --git a/README.md b/README.md\n+Fixture change\n")

        let error = try decodeServerMessage("server/error-invalid-message.json")
        guard case let .error(errorMessage) = error else {
            return XCTFail("Expected error response")
        }
        XCTAssertEqual(errorMessage.error.code, "invalid-message")
    }

    func testEncodesSwiftCommandFixtures() throws {
        try assertEncodesFixture(
            MobileRequestMessage(
                id: "dispatch-turn-start-1",
                method: "orchestration.dispatchCommand",
                payload: ThreadTurnStartCommand(
                    commandId: "mobile-turn-start-1",
                    threadId: "thread-fixture",
                    message: UserMessagePayload(
                        messageId: "message-mobile-1",
                        text: "Continue from mobile."
                    ),
                    createdAt: "2026-05-10T00:00:05.000Z"
                )
            ),
            fixture: "client/turn-start-request.json"
        )

        try assertEncodesFixture(
            MobileRequestMessage(
                id: "dispatch-interrupt-1",
                method: "orchestration.dispatchCommand",
                payload: ThreadTurnInterruptCommand(
                    commandId: "mobile-interrupt-1",
                    threadId: "thread-fixture",
                    turnId: "turn-fixture-1",
                    createdAt: "2026-05-10T00:00:06.000Z"
                )
            ),
            fixture: "client/turn-interrupt-request.json"
        )

        try assertEncodesFixture(
            MobileRequestMessage(
                id: "dispatch-approval-1",
                method: "orchestration.dispatchCommand",
                payload: ThreadApprovalRespondCommand(
                    commandId: "mobile-approval-1",
                    threadId: "thread-fixture",
                    requestId: "approval-fixture-1",
                    decision: "accept",
                    createdAt: "2026-05-10T00:00:07.000Z"
                )
            ),
            fixture: "client/approval-respond-request.json"
        )

        try assertEncodesFixture(
            MobileRequestMessage(
                id: "dispatch-user-input-1",
                method: "orchestration.dispatchCommand",
                payload: ThreadUserInputRespondCommand(
                    commandId: "mobile-user-input-1",
                    threadId: "thread-fixture",
                    requestId: "approval-fixture-2",
                    answers: [
                        "choice": .string("yes"),
                        "confirmed": .bool(true),
                    ],
                    createdAt: "2026-05-10T00:00:08.000Z"
                )
            ),
            fixture: "client/user-input-respond-request.json"
        )

        try assertEncodesFixture(
            MobileRequestMessage(
                id: "dispatch-session-stop-1",
                method: "orchestration.dispatchCommand",
                payload: ThreadSessionStopCommand(
                    commandId: "mobile-session-stop-1",
                    threadId: "thread-fixture",
                    createdAt: "2026-05-10T00:00:09.000Z"
                )
            ),
            fixture: "client/session-stop-request.json"
        )

        try assertEncodesFixture(
            MobileRequestMessage(
                id: "dispatch-checkpoint-revert-1",
                method: "orchestration.dispatchCommand",
                payload: ThreadCheckpointRevertCommand(
                    commandId: "mobile-checkpoint-revert-1",
                    threadId: "thread-fixture",
                    turnCount: 1,
                    createdAt: "2026-05-10T00:00:10.000Z"
                )
            ),
            fixture: "client/checkpoint-revert-request.json"
        )
    }

    func testTimingNamesCoverFirstSyncMeasurements() {
        XCTAssertEqual(
            Set(MobileProtocolTimingName.allCases.map(\.rawValue)),
            [
                "app_launch_start",
                "cached_shell_load_complete",
                "first_shell_render",
                "websocket_connected",
                "first_shell_snapshot_received",
                "first_thread_snapshot_received",
                "first_live_event_applied",
                "active_transcript_render_complete",
                "replay_gap_detected",
                "resnapshot_complete",
            ]
        )
    }

    private func decodeServerMessage(_ relativePath: String) throws -> MobileServerMessage {
        try decodeFixture(relativePath, as: MobileServerMessage.self)
    }

    private func decodeFixture<T: Decodable>(_ relativePath: String, as type: T.Type) throws -> T {
        let data = try Data(contentsOf: fixtureURL(relativePath))
        return try decoder.decode(type, from: data)
    }

    private func assertEncodesFixture<T: Encodable>(_ value: T, fixture relativePath: String) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let encoded = try decoder.decode(JSONValue.self, from: encoder.encode(value))
        let expected = try decodeFixture(relativePath, as: JSONValue.self)
        XCTAssertEqual(encoded, expected)
    }

    private func fixtureURL(_ relativePath: String) -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/mobile-v1")
            .appendingPathComponent(relativePath)
    }
}
