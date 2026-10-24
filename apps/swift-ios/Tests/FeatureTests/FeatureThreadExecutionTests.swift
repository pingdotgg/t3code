import Foundation
import Testing
@testable import T3Code

@Suite("V2 thread execution and queue")
struct FeatureThreadExecutionTests {
    @Test
    func watchOnlyStopDoesNotRequireAnInterruptibleRun() throws {
        for runs in [[], [run("done", ordinal: 1, status: .completed)]] {
            for source in ["manual", "stack-dismissed"] {
                let execution = try FeatureThreadExecution(projection: projection(runs: runs, threadFields: [
                    "pullRequests": .array([V2Fixture.watchedPullRequest(source: source)]),
                ]))
                #expect(execution.interruptibleRun == nil)
                #expect(!execution.canInterrupt)
                #expect(execution.canStopThread == (source == "manual"))
            }
            let removed = try FeatureThreadExecution(projection: projection(runs: runs, threadFields: ["pullRequests": .array([])]))
            #expect(!removed.canStopThread)
            let archived = try FeatureThreadExecution(projection: projection(runs: runs, threadFields: [
                "pullRequests": .array([V2Fixture.watchedPullRequest()]), "archivedAt": .string(V2Fixture.now),
            ]))
            #expect(!archived.canManageQueue)
            #expect(archived.canStopThread)
        }
    }

    @Test
    func goalCanAdvanceProviderTurnsWithinTheSameRun() throws {
        // The completed provider turn can arrive after the new running turn.
        let execution = try FeatureThreadExecution(projection: projection(
            runs: [run("goal", ordinal: 1, status: .running)],
            turns: [turn(attempt: "attempt-goal", status: "running"), turn(attempt: "attempt-goal", status: "completed")]
        ))
        #expect(execution.canInterrupt)
        #expect(execution.canStopThread)
        #expect(execution.interruptibleRun?.id == "goal")
    }

    @Test
    func newerQueuedRunDoesNotReplaceActiveWork() throws {
        let execution = try FeatureThreadExecution(projection: projection(
            runs: [
                run("queued", ordinal: 8, status: .queued),
                run("active", ordinal: 2, status: .running),
                run("older", ordinal: 1, status: .completed),
            ],
            messages: [message("queued", text: "Follow up")],
            turns: [turn(attempt: "attempt-active", status: "running")]
        ))

        #expect(execution.activeRun?.id == "active")
        #expect(execution.interruptibleRun?.id == "active")
        #expect(execution.queuedEntries.map(\.id) == ["queued"])
        #expect(execution.canPromoteToSteer)
        #expect(execution.canInterrupt)
        #expect(execution.allows(.promoteToSteer(queuedRunID: "queued", targetRunID: "active")))
        #expect(!execution.allows(.promoteToSteer(queuedRunID: "queued", targetRunID: "older")))
    }

    @Test(arguments: [
        FeatureThreadExecution.RunStatus.preparing, .starting, .running, .waiting,
    ])
    func unstartedAndWaitingRunsRemainActive(_ status: FeatureThreadExecution.RunStatus) throws {
        let execution = try FeatureThreadExecution(projection: projection(runs: [
            run("active", ordinal: 1, status: status),
            run("queued", ordinal: 2, status: .queued, held: true),
        ]))

        #expect(execution.activeRun?.id == "active")
        #expect(execution.activeRun?.startedAt == nil)
        #expect(execution.activeRun?.activityStartedAt == "2026-10-01T12:00:00.000Z")
        #expect(execution.isQueueHeld)
        #expect(!execution.canPromoteToSteer)
        #expect(execution.canInterrupt == (status != .waiting))
        #expect(execution.interruptibleRun?.id == (status == .waiting ? nil : "active"))
    }

    @Test
    func heldQueueIsIdleAndPreservesMessageAndAttachmentData() throws {
        let image: JSONValue = .object([
            "type": .string("image"), "id": .string("image"), "name": .string("reference.png"),
            "mimeType": .string("image/png"), "sizeBytes": .number(512),
        ])
        let execution = try FeatureThreadExecution(projection: projection(
            runs: [
                run("last", ordinal: 7, status: .queued, held: true),
                run("second", ordinal: 5, status: .queued, position: 1),
                run("first", ordinal: 4, status: .queued, position: 1),
                run("finished", ordinal: 8, status: .completed),
            ],
            messages: [message("first", text: "Use this image", attachments: [image])]
        ))

        #expect(execution.activeRun == nil)
        #expect(execution.interruptibleRun == nil)
        #expect(execution.queuedEntries.map(\.id) == ["first", "second", "last"])
        #expect(execution.isQueueHeld)
        #expect(execution.allows(.resume))
        #expect(!execution.canInterrupt)
        #expect(!execution.canPromoteToSteer)
        let first = try #require(execution.queuedEntries.first)
        #expect(first.text == "Use this image")
        #expect(first.messageID == "message-first")
        #expect(first.attachments.first?.name == "reference.png")
        #expect(first.attachments.first?.sizeBytes == 512)
        #expect(first.hasMessage)
        #expect(execution.queuedEntries[1].text == "Queued message")
        #expect(!execution.queuedEntries[1].hasMessage)
        #expect(!execution.allows(.edit(runID: "second", text: "Replacement")))
    }

    @Test
    func automaticDeliveriesAreNotUserQueueEntriesButCanHoldTheQueue() throws {
        let completion = message("completion", text: "Result", extra: ["delegatedCompletion": .object([:])])
        let notification = message("notification", text: "Done", extra: ["notification": .object([:])])
        let execution = try FeatureThreadExecution(projection: projection(
            runs: [
                run("completion", ordinal: 1, status: .queued, held: true),
                run("notification", ordinal: 2, status: .queued),
                run("user", ordinal: 3, status: .queued),
                run("cancelled", ordinal: 4, status: .cancelled),
            ],
            messages: [completion, notification, message("user", text: "My follow up")]
        ))

        #expect(execution.activeRun == nil)
        #expect(execution.isQueueHeld)
        #expect(execution.queuedEntries.map(\.id) == ["user"])
        #expect(!execution.allows(.cancel(runID: "completion")))
        #expect(!execution.allows(.edit(runID: "notification", text: "Change")))
    }

    @Test
    func promotionRequiresTheCurrentRunningProviderAttempt() throws {
        for providerTurn in [
            turn(attempt: "attempt-active", status: "completed"),
            turn(attempt: "attempt-previous", status: "running"),
            turn(attempt: nil, status: "running"),
        ] {
            let execution = try FeatureThreadExecution(projection: projection(
                runs: [run("active", ordinal: 1, status: .running)], turns: [providerTurn]
            ))
            #expect(!execution.canPromoteToSteer)
        }
        let noAttempt = run("active", ordinal: 1, status: .running, extra: ["activeAttemptId": .null])
        let execution = try FeatureThreadExecution(projection: projection(
            runs: [noAttempt], turns: [turn(attempt: nil, status: "running")]
        ))
        #expect(!execution.canPromoteToSteer)
        #expect(!execution.canInterrupt)
    }

    @Test
    func capabilitiesComeFromTheActiveRunsSessionDuringHandoff() throws {
        let execution = try FeatureThreadExecution(projection: projection(
            runs: [run("active", ordinal: 1, status: .running)],
            turns: [turn(attempt: "attempt-active", status: "running")],
            sessions: [
                session(id: "session", queued: false, steer: false, interrupt: false),
                session(id: "new-session"),
            ],
            threadFields: ["activeProviderThreadId": .string("new-provider-thread")],
            extraProviderThreads: [.object([
                "id": .string("new-provider-thread"), "appThreadId": .string("thread"),
                "providerSessionId": .string("new-session"),
            ])]
        ))

        #expect(!execution.canReorder)
        #expect(!execution.canPromoteToSteer)
        #expect(!execution.canInterrupt)
    }

    @Test
    func restartSteeringIsSupportedButStoppedSessionsCannotSteer() throws {
        for status in ["running", "stopped", "error"] {
            let execution = try FeatureThreadExecution(projection: projection(
                runs: [run("active", ordinal: 1, status: .running)],
                turns: [turn(attempt: "attempt-active", status: "running")],
                sessions: [session(status: status, steer: false, restartSteer: true)]
            ))
            #expect(execution.canPromoteToSteer == (status == "running"))
            #expect(execution.canInterrupt == (status == "running"))
        }
    }

    @Test
    func preparationCanStopBeforeAProviderSessionExists() throws {
        let execution = try FeatureThreadExecution(projection: projection(
            runs: [run("active", ordinal: 1, status: .preparing)], sessions: []
        ))

        #expect(execution.canInterrupt)
        #expect(execution.allows(.interrupt(runID: "active", holdQueue: true)))
        #expect(!execution.canReorder)
        #expect(!execution.canPromoteToSteer)
    }

    @Test(arguments: ["app_owned", "provider_native"])
    func completedRootCanStopActiveSubagents(_ origin: String) throws {
        let execution = try FeatureThreadExecution(projection: projection(
            runs: [run("root", ordinal: 1, status: .completed)],
            turns: [turn(attempt: "attempt-root", status: "completed")],
            items: [backgroundItem(type: "subagent", runID: "root", extra: ["origin": .string(origin)])]
        ))
        #expect(execution.activeRun == nil)
        #expect(execution.interruptibleRun?.id == "root")
        #expect(execution.canInterrupt)
        #expect(execution.allows(.interrupt(runID: "root", holdQueue: true)))
        #expect(!execution.allows(.interrupt(runID: "child", holdQueue: true)))
        #expect(!execution.canSteer)
        #expect(!execution.canRestart)
    }

    @Test(arguments: ["subagent", "command", "monitor", "background_task"])
    func providerRosterKeepsStopAvailableAfterRootCompletion(_ kind: String) throws {
        let execution = try FeatureThreadExecution(projection: projection(
            runs: [run("root", ordinal: 1, status: .completed)],
            turns: [turn(attempt: "attempt-root", status: "completed")],
            pendingTasks: [.object(["taskId": .string("task"), "kind": .string(kind)])]
        ))
        #expect(execution.interruptibleRun?.id == "root")
        #expect(execution.canInterrupt)
    }

    @Test
    func backgroundStopUsesLatestRunAndCanSettleReleasedSessions() throws {
        for sessionStatus in ["running", "stopped", "error"] {
            let execution = try FeatureThreadExecution(projection: projection(
                runs: [run("latest", ordinal: 2, status: .completed), run("older", ordinal: 1, status: .completed)],
                turns: [turn(attempt: "attempt-latest", status: "completed")],
                sessions: [session(status: sessionStatus)],
                items: [backgroundItem(type: "command_execution", runID: "older")]
            ))
            #expect(execution.interruptibleRun?.id == "latest")
            #expect(execution.canInterrupt)
        }
        for sessions in [[], [session(interrupt: false)]] {
            let execution = try FeatureThreadExecution(projection: projection(
                runs: [run("root", ordinal: 1, status: .completed)],
                turns: [turn(attempt: "attempt-root", status: "completed")], sessions: sessions,
                items: [backgroundItem(type: "dynamic_tool", runID: nil)]
            ))
            #expect(execution.canInterrupt == sessions.isEmpty)
        }
        let missingTurn = try FeatureThreadExecution(projection: projection(
            runs: [run("root", ordinal: 1, status: .completed)],
            items: [backgroundItem(type: "subagent", runID: "root")]
        ))
        #expect(!missingTurn.canInterrupt)
    }

    @Test
    func settledBackgroundGateExcludesQueuedAndRolledBackLatestRuns() throws {
        for status in FeatureThreadExecution.RunStatus.allCases where !status.isInterruptible {
            let execution = try FeatureThreadExecution(projection: projection(
                runs: [run("latest", ordinal: 2, status: status), run("older", ordinal: 1, status: .completed)],
                turns: [turn(attempt: "attempt-latest", status: "completed")],
                pendingTasks: [.object(["taskId": .string("task"), "kind": .string("subagent")])]
            ))
            let canStop = status != .queued && status != .rolledBack
            #expect(execution.canInterrupt == canStop)
            #expect(execution.interruptibleRun?.id == (canStop ? "latest" : nil))
        }
        let foreground = try FeatureThreadExecution(projection: projection(
            runs: [run("completed", ordinal: 3, status: .completed), run("active", ordinal: 1, status: .running)],
            turns: [turn(attempt: "attempt-active", status: "running")],
            items: [backgroundItem(type: "subagent", runID: "completed")]
        ))
        #expect(foreground.canInterrupt)
        #expect(foreground.interruptibleRun?.id == "active")
    }

    @Test
    func completedThreadWithoutEligibleBackgroundWorkCannotStop() throws {
        for items in [
            [],
            [backgroundItem(type: "subagent", runID: "root", status: "completed")],
            [backgroundItem(type: "dynamic_tool", runID: "root", extra: ["input": .object(["persistent": .bool(true)])])],
            [backgroundItem(type: "subagent", runID: "abandoned")],
            [backgroundItem(type: "user_input_request", runID: "root")],
        ] {
            let execution = try FeatureThreadExecution(projection: projection(
                runs: [run("root", ordinal: 2, status: .completed), run("abandoned", ordinal: 1, status: .rolledBack)],
                turns: [turn(attempt: "attempt-root", status: "completed")],
                extraProviderThreads: [.object([
                    "id": .string("previous-provider"), "pendingBackgroundTasks": .array([
                        .object(["taskId": .string("stale"), "kind": .string("subagent")]),
                    ]),
                ])],
                pendingTasks: [.object(["taskId": .string(""), "kind": .string("subagent")])], items: items
            ))
            #expect(!execution.canInterrupt)
            #expect(execution.interruptibleRun == nil)
        }
    }

    @Test
    func runlessProviderNativeSubagentRemainsReadOnlyWithBackgroundWork() throws {
        let execution = try FeatureThreadExecution(projection: projection(
            runs: [], turns: [turn(attempt: nil, status: "running")],
            threadFields: ["creationSource": .string("provider"), "lineage": .object(["relationshipToParent": .string("subagent")])],
            pendingTasks: [.object(["taskId": .string("task"), "kind": .string("subagent")])],
            items: [backgroundItem(type: "subagent", runID: nil)]
        ))
        #expect(!execution.canManageQueue)
        #expect(execution.activeRun == nil)
        #expect(execution.interruptibleRun == nil)
        #expect(!execution.canInterrupt)
        #expect(!execution.allows(.interrupt(runID: "v2-node:child-root", holdQueue: true)))
    }

    @Test
    func normalizedSnapshotAndLiveBackgroundCompletionAgreeWithFullProjection() throws {
        let snapshot = try V2Fixture.load("v2-thread-bounded-snapshot")
        let raw = try #require(snapshot["projection"])
        let root = try #require(raw["runs"]?.v2Array?.first { $0["id"] == .string("run-v2-active") })
        let item = V2Fixture.patch(V2Fixture.item("background", type: "command_execution", ordinal: 100, fields: ["input": .string("long task")]), [
            "threadId": .string("thread-v2"), "runId": .string("run-v2-active"),
        ])
        let projection = V2Fixture.patch(raw, [
            "runs": .array([V2Fixture.patch(root, ["status": .string("completed")])]),
            "turnItems": .array([item]), "visibleTurnItems": .array([]),
        ])
        var state = try OrchestrationV2ThreadState(snapshot: V2Fixture.patch(snapshot, ["projection": projection]))
        let full = try FeatureThreadExecution(projection: projection)
        let normalized = try FeatureThreadExecution(projection: #require(state.normalizedSnapshot().thread.orchestrationV2Control))
        #expect(full == normalized)
        #expect(normalized.canInterrupt)
        let event = V2Fixture.event("turn-item.updated", payload: V2Fixture.patch(item, ["status": .string("completed")]), sequence: 101)
        let eventPayload = V2Fixture.patch(try #require(event["event"]), ["threadId": .string("thread-v2")])
        #expect(!state.apply([V2Fixture.patch(event, ["event": eventPayload])]).refreshRequired)
        let completed = try FeatureThreadExecution(projection: #require(state.normalizedSnapshot().thread.orchestrationV2Control))
        #expect(!completed.canInterrupt)
    }

    @Test
    func queueActionsRequireCurrentTargetsAndNonemptyEditedText() throws {
        let execution = try FeatureThreadExecution(projection: projection(
            runs: [run("first", ordinal: 1, status: .queued), run("last", ordinal: 2, status: .queued)],
            messages: [message("first", text: "First"), message("last", text: "Last")]
        ))

        #expect(execution.allows(.cancel(runID: "first")))
        #expect(execution.allows(.edit(runID: "first", text: "New text")))
        #expect(!execution.allows(.edit(runID: "first", text: " \n")))
        #expect(!execution.allows(.cancel(runID: "gone")))
        #expect(execution.allows(.reorder(runID: "last", beforeRunID: "first")))
        #expect(execution.allows(.reorder(runID: "first", beforeRunID: nil)))
        #expect(!execution.allows(.reorder(runID: "first", beforeRunID: "first")))
        #expect(!execution.allows(.reorder(runID: "first", beforeRunID: "gone")))
        #expect(!execution.allows(.resume))
    }

    @Test
    func archivedAndProviderNativeThreadsHaveNoQueueControls() throws {
        for fields: [String: JSONValue] in [
            ["archivedAt": .string("2026-10-01T12:00:00.000Z")],
            ["deletedAt": .string("2026-10-01T12:00:00.000Z")],
            ["creationSource": .string("provider"), "lineage": .object(["relationshipToParent": .string("subagent")])],
        ] {
            let execution = try FeatureThreadExecution(projection: projection(
                runs: [run("queued", ordinal: 1, status: .queued, held: true)],
                messages: [message("queued", text: "Follow up")], threadFields: fields
            ))
            #expect(!execution.canManageQueue)
            #expect(execution.isReadOnly == (fields["creationSource"] == .string("provider")))
            #expect(!execution.canReorder)
            #expect(!execution.allows(.resume))
            #expect(!execution.allows(.cancel(runID: "queued")))
        }
    }

    @Test
    func executionRoundTripsWithoutLosingQueueMetadata() throws {
        let execution = try FeatureThreadExecution(projection: projection(
            runs: [run("queued", ordinal: 1, status: .queued, held: true)],
            messages: [message("queued", text: "Follow up")]
        ))
        let data = try JSONEncoder().encode(execution)
        #expect(try JSONDecoder().decode(FeatureThreadExecution.self, from: data) == execution)
        #expect(throws: DecodingError.self) {
            try FeatureThreadExecution(projection: .object(["thread": .object(["id": .string("legacy")])]))
        }
    }

    private func run(
        _ id: String, ordinal: Int, status: FeatureThreadExecution.RunStatus,
        position: Int? = nil, held: Bool = false, extra: [String: JSONValue] = [:]
    ) -> JSONValue {
        .object([
            "id": .string(id), "ordinal": .number(Double(ordinal)), "status": .string(status.rawValue),
            "userMessageId": .string("message-\(id)"), "providerThreadId": .string("provider-thread"),
            "activeAttemptId": .string("attempt-\(id)"), "rootNodeId": .string("node-\(id)"),
            "queuePosition": position.map { .number(Double($0)) } ?? .null, "queueHeld": .bool(held),
            "requestedAt": .string("2026-10-01T12:00:00.000Z"), "startedAt": .null, "completedAt": .null,
        ].merging(extra) { _, replacement in replacement })
    }

    private func message(
        _ runID: String, text: String, attachments: [JSONValue] = [], extra: [String: JSONValue] = [:]
    ) -> JSONValue {
        .object([
            "id": .string("message-\(runID)"), "text": .string(text), "attachments": .array(attachments),
        ].merging(extra) { _, replacement in replacement })
    }

    private func turn(attempt: String?, status: String) -> JSONValue {
        .object(["runAttemptId": attempt.map(JSONValue.string) ?? .null, "status": .string(status)])
    }

    private func backgroundItem(type: String, runID: String?, status: String = "running", extra: [String: JSONValue] = [:]) -> JSONValue {
        .object([
            "type": .string(type), "runId": runID.map(JSONValue.string) ?? .null, "status": .string(status),
        ].merging(extra) { _, replacement in replacement })
    }

    private func session(
        id: String = "session", status: String = "running", queued: Bool = true,
        steer: Bool = true, restartSteer: Bool = false, interrupt: Bool = true
    ) -> JSONValue {
        .object([
            "id": .string(id), "status": .string(status), "capabilities": .object([
                "turns": .object([
                    "supportsQueuedMessages": .bool(queued), "supportsActiveSteering": .bool(steer),
                    "supportsSteeringByInterruptRestart": .bool(restartSteer), "supportsInterrupt": .bool(interrupt),
                ]),
            ]),
        ])
    }

    private func projection(
        runs: [JSONValue], messages: [JSONValue] = [], turns: [JSONValue] = [],
        sessions: [JSONValue]? = nil, threadFields: [String: JSONValue] = [:],
        extraProviderThreads: [JSONValue] = [], pendingTasks: [JSONValue] = [], items: [JSONValue] = []
    ) -> JSONValue {
        .object([
            "thread": .object([
                "id": .string("thread"), "activeProviderThreadId": .string("provider-thread"),
            ].merging(threadFields) { _, replacement in replacement }),
            "runs": .array(runs), "messages": .array(messages), "providerTurns": .array(turns),
            "turnItems": .array(items),
            "providerSessions": .array(sessions ?? [session()]),
            "providerThreads": .array([.object([
                "id": .string("provider-thread"), "appThreadId": .string("thread"),
                "providerSessionId": .string("session"),
                "pendingBackgroundTasks": .array(pendingTasks),
            ])] + extraProviderThreads),
            "nodes": .array(runs.compactMap { run in
                run["rootNodeId"]?.stringValue.map { .object(["id": .string($0)]) }
            }),
            "attempts": .array(runs.compactMap { run in
                run["activeAttemptId"]?.stringValue.map { .object(["id": .string($0)]) }
            }),
        ])
    }
}
