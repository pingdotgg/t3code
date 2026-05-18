import Foundation
import Testing
import T3MobileProtocol
@testable import T3Mobile

struct MobileSyncProjectionMapperTests {
    private let mapper = MobileSyncProjectionMapper()

    @Test func appliesShellThreadUpsertAndRemoval() throws {
        let initial = MobileShellState(
            snapshotSequence: 5,
            projects: [
                MobileProject(id: "project-fixture", title: "Fixture Project", workspaceRoot: "/tmp/fixture"),
            ],
            threads: []
        )
        let upsert = MobileStreamMessage(
            protocolVersion: mobileProtocolVersion,
            serverCapabilities: [],
            id: "shell-2",
            type: "stream",
            payload: .init(
                kind: "thread-upserted",
                sequence: 6,
                snapshot: nil,
                event: nil,
                project: nil,
                thread: threadShellJSON,
                projectId: nil,
                threadId: nil
            )
        )
        let removed = MobileStreamMessage(
            protocolVersion: mobileProtocolVersion,
            serverCapabilities: [],
            id: "shell-3",
            type: "stream",
            payload: .init(
                kind: "thread-removed",
                sequence: 7,
                snapshot: nil,
                event: nil,
                project: nil,
                thread: nil,
                projectId: nil,
                threadId: "thread-fixture"
            )
        )

        let withThread = try mapper.applyShellStream(upsert, to: initial)
        #expect(withThread.snapshotSequence == 6)
        #expect(withThread.threads.first?.id == "thread-fixture")

        let withoutThread = try mapper.applyShellStream(removed, to: withThread)
        #expect(withoutThread.snapshotSequence == 7)
        #expect(withoutThread.threads.isEmpty)
    }

    @Test func decodesThreadSnapshotAndAppliesThreadEvents() throws {
        var detail = try mapper.threadDetail(fromSnapshot: threadSnapshotJSON)
        #expect(detail.threadID == "thread-fixture")
        #expect(detail.messages.map(\.id) == ["message-user-1"])

        detail = try #require(try mapper.applyReplayEvent(messageEventJSON, to: detail))
        #expect(detail.snapshotSequence == 8)
        #expect(detail.messages.map(\.id).contains("message-assistant-1"))

        detail = try #require(try mapper.applyReplayEvent(activityEventJSON, to: detail))
        #expect(detail.snapshotSequence == 9)
        #expect(detail.activities.first?.summary == "Ran tests")
        #expect(detail.timelineItems.map(\.id) == [
            "message:message-user-1",
            "message:message-assistant-1",
            "activity:activity-1",
        ])
    }

    @Test func messageIdentifierUsesCanonicalId() throws {
        let detail = try mapper.threadDetail(fromSnapshot: threadSnapshotJSON)
        #expect(detail.messages.first?.id == "message-user-1")
    }

    @Test func appliesProposedPlanAndCheckpointEvents() throws {
        var detail = try mapper.threadDetail(fromSnapshot: threadSnapshotJSON)

        detail = try #require(try mapper.applyReplayEvent(proposedPlanEventJSON, to: detail))
        detail = try #require(try mapper.applyReplayEvent(turnDiffCompletedEventJSON, to: detail))

        #expect(detail.proposedPlans.first?.id == "plan-1")
        #expect(detail.proposedPlans.first?.markdown == "1. Build the mobile UI")
        #expect(detail.checkpoints.first?.turnID == "turn-2")
        #expect(detail.checkpoints.first?.turnCount == 2)
        #expect(detail.checkpoints.first?.files.first?.path == "apps/mobile/App/ShellView.swift")
        #expect(detail.timelineItems.map(\.id).contains("plan:plan-1"))
        #expect(detail.timelineItems.map(\.id).contains("checkpoint:turn-2:2"))
    }

    @Test func decodesTypedActivityInteractionsWithoutKindSubstringGuessing() throws {
        let detail = try mapper.threadDetail(fromSnapshot: activityInteractionSnapshotJSON)

        #expect(detail.activities.map(\.interactionKind) == [.userInputRequest, .approvalRequest, .generic])
        #expect(detail.activities.map(\.requestID) == ["input-1", "approval-1", "schema-1"])
    }

    private var threadSnapshotJSON: JSONValue {
        .object([
            "snapshotSequence": .number(5),
            "thread": .object([
                "id": .string("thread-fixture"),
                "title": .string("Fixture Thread"),
                "messages": .array([
                    .object([
                        "id": .string("message-user-1"),
                        "role": .string("user"),
                        "text": .string("Hello"),
                        "streaming": .bool(false),
                        "createdAt": .string("2026-05-10T00:00:01.000Z"),
                    ]),
                ]),
                "activities": .array([]),
                "session": .object([
                    "status": .string("ready"),
                    "lastError": .null,
                ]),
            ]),
        ])
    }

    private var threadShellJSON: JSONValue {
        .object([
            "id": .string("thread-fixture"),
            "projectId": .string("project-fixture"),
            "title": .string("Fixture Thread"),
            "latestTurn": .null,
            "session": .null,
            "hasPendingApprovals": .bool(false),
            "hasPendingUserInput": .bool(false),
            "hasActionableProposedPlan": .bool(false),
        ])
    }

    private var messageEventJSON: JSONValue {
        .object([
            "sequence": .number(8),
            "type": .string("thread.message-sent"),
            "payload": .object([
                "threadId": .string("thread-fixture"),
                "id": .string("message-assistant-1"),
                "role": .string("assistant"),
                "text": .string("Hi"),
                "streaming": .bool(false),
                "createdAt": .string("2026-05-10T00:00:02.000Z"),
            ]),
        ])
    }

    private var activityEventJSON: JSONValue {
        .object([
            "sequence": .number(9),
            "type": .string("thread.activity-appended"),
            "payload": .object([
                "threadId": .string("thread-fixture"),
                "activity": .object([
                    "id": .string("activity-1"),
                    "tone": .string("tool"),
                    "kind": .string("test"),
                    "summary": .string("Ran tests"),
                    "createdAt": .string("2026-05-10T00:00:03.000Z"),
                ]),
            ]),
        ])
    }

    private var proposedPlanEventJSON: JSONValue {
        .object([
            "sequence": .number(10),
            "type": .string("thread.proposed-plan-upserted"),
            "payload": .object([
                "threadId": .string("thread-fixture"),
                "proposedPlan": .object([
                    "id": .string("plan-1"),
                    "turnId": .string("turn-2"),
                    "planMarkdown": .string("1. Build the mobile UI"),
                    "implementedAt": .null,
                    "createdAt": .string("2026-05-10T00:00:04.000Z"),
                ]),
            ]),
        ])
    }

    private var turnDiffCompletedEventJSON: JSONValue {
        .object([
            "sequence": .number(11),
            "type": .string("thread.turn-diff-completed"),
            "payload": .object([
                "threadId": .string("thread-fixture"),
                "turnId": .string("turn-2"),
                "checkpointTurnCount": .number(2),
                "status": .string("completed"),
                "completedAt": .string("2026-05-10T00:00:05.000Z"),
                "files": .array([
                    .object([
                        "path": .string("apps/mobile/App/ShellView.swift"),
                        "additions": .number(12),
                        "deletions": .number(1),
                    ]),
                ]),
            ]),
        ])
    }

    private var activityInteractionSnapshotJSON: JSONValue {
        .object([
            "snapshotSequence": .number(5),
            "thread": .object([
                "id": .string("thread-fixture"),
                "title": .string("Fixture Thread"),
                "messages": .array([]),
                "activities": .array([
                    .object([
                        "id": .string("activity-input"),
                        "tone": .string("prompt"),
                        "kind": .string("question"),
                        "summary": .string("Need clarification"),
                        "requestId": .string("input-1"),
                        "interactionKind": .string("user-input"),
                        "createdAt": .string("2026-05-10T00:00:01.000Z"),
                    ]),
                    .object([
                        "id": .string("activity-approval"),
                        "tone": .string("approval"),
                        "kind": .string("file-change"),
                        "summary": .string("Approve file write"),
                        "requestId": .string("approval-1"),
                        "createdAt": .string("2026-05-10T00:00:02.000Z"),
                    ]),
                    .object([
                        "id": .string("activity-schema"),
                        "tone": .string("tool"),
                        "kind": .string("file-input-validation"),
                        "summary": .string("Validated input schema"),
                        "requestId": .string("schema-1"),
                        "createdAt": .string("2026-05-10T00:00:03.000Z"),
                    ]),
                ]),
                "session": .object([
                    "status": .string("ready"),
                    "lastError": .null,
                ]),
            ]),
        ])
    }
}
