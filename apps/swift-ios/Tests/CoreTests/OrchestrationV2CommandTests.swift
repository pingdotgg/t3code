import XCTest
@testable import T3Code

@MainActor
final class OrchestrationV2CommandTests: XCTestCase {
    func testBootstrapLaunchIsAtomicAndRetainsMessageIdentity() throws {
        var command = turn()
        command["titleSeed"] = .string("Fix the queue")
        command["bootstrap"] = .object([
            "createThread": projection()["thread"]!,
            "prepareWorktree": .object([
                "projectCwd": .string("/repo"), "baseBranch": .string("main"),
                "branch": .string("fix-queue"), "startFromOrigin": .bool(true),
            ]),
            "runSetupScript": .bool(true),
        ])
        let plan = try OrchestrationV2Commands.plan(.object(command))
        XCTAssertEqual(plan.requests.count, 1)
        let request = try XCTUnwrap(plan.requests.first)
        XCTAssertEqual(request.method, "orchestration.launchThread")
        XCTAssertEqual(request.responseKind, .launch)
        XCTAssertEqual(request.payload, .object([
            "commandId": .string("command"), "threadId": .string("thread"),
            "creationSource": .string("mobile"), "projectId": .string("project"),
            "title": .string("Fix the queue"), "generateTitle": .bool(true),
            "modelSelection": model, "runtimeMode": .string("full-access"),
            "interactionMode": .string("plan"),
            "workspaceStrategy": .object([
                "type": .string("worktree"), "baseRef": .string("main"),
                "branch": .string("fix-queue"), "startFromOrigin": .bool(true),
            ]),
            "initialMessage": .object([
                "messageId": .string("message"), "text": .string("Fix this"), "attachments": .array([]),
            ]),
        ]))
        XCTAssertEqual(try OrchestrationV2Commands.plan(.object(command)), plan)
    }

    func testLaunchDistinguishesRootExistingWorktreeAndPreparationOnExistingThread() throws {
        for (path, expectedType) in [(JSONValue.null, "root"), (.string("/repo-worktree"), "existing_worktree")] {
            var thread = try object(projection()["thread"])
            thread["branch"] = .string("feature")
            thread["worktreePath"] = path
            var command = turn()
            command["bootstrap"] = .object(["createThread": .object(thread)])
            let result = try XCTUnwrap(OrchestrationV2Commands.plan(.object(command)).requests.first)
            XCTAssertEqual(result.payload["workspaceStrategy"]?["type"], .string(expectedType))
            XCTAssertEqual(result.payload["workspaceStrategy"]?["branch"], .string("feature"))
            XCTAssertNil(result.payload["reuseExistingThread"])
        }
        var command = turn()
        command["bootstrap"] = .object(["prepareWorktree": .object(["baseBranch": .string("main")])])
        XCTAssertTrue(OrchestrationV2Commands.requiresProjection(.object(command), serverResolvedCommandContext: true))
        XCTAssertThrowsError(try OrchestrationV2Commands.plan(.object(command)))
        let request = try XCTUnwrap(OrchestrationV2Commands.plan(.object(command), projection: projection()).requests.first)
        XCTAssertEqual(request.payload["reuseExistingThread"], .bool(true))
        XCTAssertEqual(request.payload["projectId"], .string("project"))
    }

    func testCreateThreadAddsV2OriginAndProjectUsesSeparateRPC() throws {
        var create = try object(projection()["thread"])
        create.removeValue(forKey: "id")
        create.removeValue(forKey: "providerInstanceId")
        create.merge(intent("thread.create")) { _, new in new }
        create["createdAt"] = .string("2026-10-04T00:00:00Z")
        let request = try XCTUnwrap(OrchestrationV2Commands.plan(.object(create)).requests.first)
        XCTAssertEqual(request.payload["createdBy"], .string("user"))
        XCTAssertEqual(request.payload["creationSource"], .string("mobile"))
        XCTAssertNil(request.payload["createdAt"])

        for type in ["project.create", "project.update", "project.delete"] {
            var mutation: [String: JSONValue] = [
                "type": .string(type), "commandId": .string("project-command"), "projectId": .string("project"),
                "createdAt": .string("2026-10-04T00:00:00Z"),
            ]
            if type == "project.create" {
                mutation["title"] = .string("Project")
                mutation["workspaceRoot"] = .string("/repo")
                mutation["createWorkspaceRootIfMissing"] = .bool(true)
                mutation["defaultModelSelection"] = .null
            } else if type == "project.update" {
                mutation["defaultModelSelection"] = .null
                mutation["scripts"] = .array([])
            } else { mutation["force"] = .bool(true) }
            let step = try XCTUnwrap(OrchestrationV2Commands.plan(.object(mutation)).requests.first)
            XCTAssertEqual(step.method, "projects.mutate")
            XCTAssertEqual(step.responseKind, .project)
            mutation.removeValue(forKey: "createdAt")
            XCTAssertEqual(step.payload, .object(mutation))
        }
    }

    func testTurnSettingsPrecedeMessageAndUseStableDerivedIDs() throws {
        let command = JSONValue.object(turn())
        let state = projection(runtimeMode: "approval-required")
        let plan = try OrchestrationV2Commands.plan(command, projection: state, serverResolvedCommandContext: true)
        XCTAssertEqual(plan.requests.map { $0.payload["type"]?.stringValue }, [
            "thread.runtime-mode.set", "thread.interaction-mode.set", "message.dispatch",
        ])
        XCTAssertEqual(plan.requests.map { $0.payload["commandId"]?.stringValue }, [
            "command:runtime-mode", "command:interaction-mode", "command",
        ])
        XCTAssertEqual(plan.requests[0].payload["runtimeMode"], .string("full-access"))
        XCTAssertEqual(plan.requests[1].payload["interactionMode"], .string("plan"))
        let message = plan.requests[2].payload
        XCTAssertEqual(message["messageId"], .string("message"))
        XCTAssertEqual(message["deliveryIntent"], .string("auto"))
        XCTAssertEqual(message["dispatchMode"], .object(["type": .string("start_immediately")]))
        XCTAssertNil(message["runtimeMode"])
        XCTAssertNil(message["message"])
        XCTAssertEqual(try OrchestrationV2Commands.plan(command, projection: state, serverResolvedCommandContext: true), plan)
    }

    func testServerResolvedFollowUpDoesNotResetUnchangedSessionModes() throws {
        var command = turn()
        command["interactionMode"] = .string("default")
        for delivery in OrchestrationV2Commands.Delivery.allCases {
            command["dispatchMode"] = .string(delivery.rawValue)
            XCTAssertTrue(OrchestrationV2Commands.requiresProjection(.object(command), serverResolvedCommandContext: true))
            let plan = try OrchestrationV2Commands.plan(.object(command), projection: projection(), serverResolvedCommandContext: true)
            XCTAssertEqual(plan.requests.map { $0.payload["type"] }, [.string("message.dispatch")])
        }
    }

    func testDeliveryUsesCapabilitiesOrServerResolvedIntent() throws {
        for (capabilities, expected) in [
            (["supportsActiveSteering": true], "steer_active"),
            (["supportsQueuedMessages": true], "queue_after_active"),
            (["supportsSteeringByInterruptRestart": true], "restart_active"),
            ([:], "queue_after_active"),
        ] {
            let state = projection(runs: [run("active", status: "running")], capabilities: capabilities)
            let sent = try XCTUnwrap(OrchestrationV2Commands.plan(.object(turn()), projection: state).requests.last).payload
            XCTAssertEqual(sent["dispatchMode"]?["type"], .string(expected))
            XCTAssertEqual(sent["dispatchMode"]?["targetRunId"], expected == "queue_after_active" ? nil : .string("active"))
            XCTAssertNil(sent["deliveryIntent"])
        }
        for delivery in OrchestrationV2Commands.Delivery.allCases {
            var command = turn()
            command["dispatchMode"] = .string(delivery.rawValue)
            let request = try XCTUnwrap(OrchestrationV2Commands.plan(.object(command), projection: projection(), serverResolvedCommandContext: true).requests.last)
            XCTAssertEqual(request.payload["deliveryIntent"], [.start, .queue].contains(delivery) ? nil : .string(delivery.rawValue))
            XCTAssertEqual(request.payload["dispatchMode"]?["type"], .string(delivery == .queue ? "queue_after_active" : "start_immediately"))
        }
        var queued = turn()
        queued["dispatchMode"] = .string("queue")
        let idle = try XCTUnwrap(OrchestrationV2Commands.plan(.object(queued), projection: projection()).requests.last)
        XCTAssertEqual(idle.payload["dispatchMode"]?["type"], .string("start_immediately"))
    }

    func testKnownSettingsAvoidExtraRPCsWithoutChangingMessageIdentity() throws {
        var command = turn()
        command["interactionMode"] = .string("default")
        let current = try OrchestrationV2Commands.plan(.object(command), projection: projection())
        XCTAssertEqual(current.requests.count, 1)
        XCTAssertEqual(current.requests.first?.payload["type"], .string("message.dispatch"))
        XCTAssertEqual(current.requests.first?.payload["commandId"], .string("command"))
        command["interactionMode"] = .string("plan")
        let changed = try OrchestrationV2Commands.plan(.object(command), projection: projection())
        XCTAssertEqual(changed.requests.count, 2)
        XCTAssertEqual(changed.requests.first?.payload["commandId"], .string("command:interaction-mode"))
        XCTAssertEqual(changed.requests.last?.payload["messageId"], .string("message"))
    }

    func testMetadataPreservesNullAndChangesProviderWithSeparateIdentity() throws {
        let command = try OrchestrationV2Commands.updateMetadata(threadID: "thread", fields: [
            "title": .string("Renamed"), "branch": .null, "worktreePath": .null,
            "linkedPullRequest": .null, "modelSelection": .object(["instanceId": .string("other"), "model": .string("next")]),
        ], commandID: "metadata")
        let plan = try OrchestrationV2Commands.plan(command, projection: projection())
        XCTAssertEqual(plan.requests.count, 2)
        XCTAssertEqual(plan.requests[0].payload["type"], .string("thread.metadata.update"))
        XCTAssertEqual(plan.requests[0].payload["linkedPullRequest"], .null)
        XCTAssertNil(plan.requests[0].payload["modelSelection"])
        XCTAssertEqual(plan.requests[1].payload["type"], .string("provider.switch"))
        XCTAssertEqual(plan.requests[1].payload["commandId"], .string("metadata:model-selection"))
        let resolved = try OrchestrationV2Commands.plan(command, serverResolvedCommandContext: true)
        XCTAssertEqual(resolved.requests[1].payload["type"], .string("thread.model-selection.set"))
        XCTAssertThrowsError(try OrchestrationV2Commands.updateMetadata(threadID: "thread", fields: ["unknown": .bool(true)]))
    }

    func testApprovalInputAndDismissRetainRuntimeRequestIDs() throws {
        for type in ["thread.approval.respond", "thread.user-input.respond", "thread.user-input.dismiss"] {
            var command = intent(type)
            command["requestId"] = .string("runtime-request")
            command["createdAt"] = .string("2026-10-04T00:00:00Z")
            if type == "thread.approval.respond" { command["decision"] = .string("acceptForSession") }
            if type == "thread.user-input.respond" {
                command["answers"] = .object(["question": .string("Choice A")])
                command["attachmentsByQuestionId"] = .object(["question": .array([attachment()])])
            }
            let request = try XCTUnwrap(OrchestrationV2Commands.plan(.object(command)).requests.first)
            XCTAssertEqual(request.payload["type"], .string(type == "thread.user-input.dismiss" ? type : "runtime-request.respond"))
            XCTAssertEqual(request.payload["requestId"], .string("runtime-request"))
            XCTAssertEqual(request.payload["answers"], command["answers"])
            XCTAssertEqual(request.payload["attachmentsByQuestionId"], command["attachmentsByQuestionId"])
            XCTAssertEqual(request.payload["decision"], command["decision"])
            XCTAssertNil(request.payload["createdAt"])
        }
    }

    func testWatchOnlyStopUsesPublicUnwatchCommandsWithStableDistinctIDs() throws {
        for runs in [[], [run("done", status: "completed")]] {
            let original = projection(runs: runs)
            let state = V2Fixture.patch(original, ["thread": V2Fixture.patch(original["thread"] ?? .null, [
                "pullRequests": .array([V2Fixture.watchedPullRequest(1), V2Fixture.watchedPullRequest(2),
                    V2Fixture.watchedPullRequest(3, source: "stack-dismissed")]),
            ])])
            let command = JSONValue.object(intent("thread.turn.interrupt"))
            let plan = try OrchestrationV2Commands.plan(command, projection: state)
            XCTAssertEqual(plan.requests.count, 2)
            XCTAssertEqual(Set(plan.requests.compactMap { $0.payload["commandId"]?.stringValue }).count, 2)
            XCTAssertEqual(plan, try OrchestrationV2Commands.plan(command, projection: state))
            for request in plan.requests {
                XCTAssertEqual(request.payload["type"], .string("thread.pull-request.watch"))
                XCTAssertEqual(request.payload["watching"], .bool(false))
                XCTAssertEqual(request.payload["host"], .string("github.com"))
                XCTAssertEqual(request.payload["repository"], .string("example/repo"))
                XCTAssertNil(request.payload["runId"])
            }
            let active = V2Fixture.patch(state, ["runs": .array([run("active", status: "running")])])
            let activePlan = try OrchestrationV2Commands.plan(command, projection: active)
            XCTAssertEqual(activePlan.requests.count, 1)
            XCTAssertEqual(activePlan.requests.first?.payload["type"], .string("run.interrupt"))
            XCTAssertEqual(activePlan.requests.first?.payload["holdQueue"], .bool(true))
        }
    }

    func testGoalTurnInterruptResolvesTheCurrentProviderTurnInsideOneRun() throws {
        let original = projection(runs: [run("goal-run", status: "running")])
        let state = V2Fixture.patch(original, [
            "attempts": .array([.object(["id": .string("attempt"), "runId": .string("goal-run")])]),
            "providerTurns": .array(["first", "current"].map { id in .object([
                "id": .string(id), "runAttemptId": .string("attempt"),
                "nativeTurnRef": .object(["nativeId": .string("native-\(id)")]),
                "status": .string(id == "current" ? "running" : "completed"),
            ]) }),
        ])
        var command = intent("thread.turn.interrupt")
        command["turnId"] = .string("native-current")
        let request = try XCTUnwrap(OrchestrationV2Commands.plan(.object(command), projection: state).requests.first)
        XCTAssertEqual(request.payload["runId"], .string("goal-run"))
        XCTAssertEqual(request.payload["holdQueue"], .bool(true))
    }

    func testInterruptResolvesActiveRunAndNeverTreatsNativeTurnIDAsRunID() throws {
        var state = try object(projection(runs: [run("older", status: "completed"), run("active", status: "running")]))
        state["providerTurns"] = .array([.object([
            "id": .string("provider-turn"), "nativeTurnRef": .object(["nativeId": .string("native-turn")]),
            "runAttemptId": .string("attempt"),
        ])])
        state["attempts"] = .array([.object(["id": .string("attempt"), "runId": .string("active")])])
        for turnID in [nil, "active", "provider-turn", "native-turn"] {
            var command = intent("thread.turn.interrupt")
            command["turnId"] = turnID.map(JSONValue.string)
            let request = try XCTUnwrap(OrchestrationV2Commands.plan(.object(command), projection: .object(state)).requests.first)
            XCTAssertEqual(request.payload["type"], .string("run.interrupt"))
            XCTAssertEqual(request.payload["runId"], .string("active"))
            XCTAssertEqual(request.payload["holdQueue"], .bool(true))
            XCTAssertNil(request.payload["turnId"])
        }
        var unknown = intent("thread.turn.interrupt")
        unknown["turnId"] = .string("wrong-turn")
        XCTAssertThrowsError(try OrchestrationV2Commands.plan(.object(unknown), projection: .object(state))) { error in
            XCTAssertEqual(error as? OrchestrationV2Commands.AdapterError, .unavailableIdentity("run for turn wrong-turn"))
        }
    }

    func testBackgroundStopSkipsPersistentAndRolledBackWork() throws {
        var state = try object(projection(runs: [run("completed", status: "completed")]))
        state["turnItems"] = .array([.object([
            "id": .string("tool"), "type": .string("dynamic_tool"), "status": .string("running"),
            "runId": .string("completed"), "input": .object(["persistent": .bool(true)]),
        ])])
        XCTAssertThrowsError(try OrchestrationV2Commands.plan(.object(intent("thread.turn.interrupt")), projection: .object(state)))
        state["turnItems"] = .array([.object([
            "id": .string("tool"), "type": .string("subagent"), "status": .string("running"), "runId": .string("completed"),
        ])])
        let request = try XCTUnwrap(OrchestrationV2Commands.plan(.object(intent("thread.turn.interrupt")), projection: .object(state)).requests.first)
        XCTAssertEqual(request.payload["runId"], .string("completed"))
        state["runs"] = .array([run("completed", status: "rolled_back")])
        XCTAssertThrowsError(try OrchestrationV2Commands.plan(.object(intent("thread.turn.interrupt")), projection: .object(state)))
    }

    func testRestartDetachesAllActualSessionsWithStableIDs() throws {
        var state = try object(projection())
        state["providerSessions"] = .array([
            .object(["id": .string("session-a")]), .object(["id": .string("session-b")]),
        ])
        let command = JSONValue.object(intent("thread.session.stop"))
        let plan = try OrchestrationV2Commands.plan(command, projection: .object(state))
        XCTAssertEqual(plan.requests.map { $0.payload["providerSessionId"] }, [.string("session-a"), .string("session-b")])
        XCTAssertEqual(plan.requests.map { $0.payload["commandId"] }, [.string("command:detach:session-a"), .string("command:detach:session-b")])
        XCTAssertTrue(plan.requests.allSatisfy { $0.payload["type"] == .string("provider-session.detach") })
        XCTAssertEqual(try OrchestrationV2Commands.plan(command, projection: .object(state)), plan)
    }

    func testRollbackUsesAppRunOrdinalAndNeverFallsBackFromWrongExplicitIdentity() throws {
        var state = try object(rollbackProjection(ordinals: [1, 2]))
        state["checkpointScopes"] = .array(["baseline", "first", "tool", "second"].map { id in
            .object(["id": .string("scope-\(id)"), "advancesAppRunCount": .bool(true),
                     "providerThreadId": .string("provider-thread")])
        })
        state["checkpoints"] = .array([
            checkpoint("baseline", ordinal: 0, appOrdinal: nil),
            checkpoint("first", ordinal: 1, appOrdinal: 1),
            checkpoint("tool", ordinal: 2, appOrdinal: nil),
            checkpoint("second", ordinal: 0, appOrdinal: 2),
        ])
        for (count, expected) in [(0, "baseline"), (1, "first"), (2, "second")] {
            var command = intent("thread.conversation.revert")
            command["turnCount"] = .number(Double(count))
            let step = try XCTUnwrap(OrchestrationV2Commands.plan(.object(command), projection: .object(state)).requests.first)
            XCTAssertEqual(step.payload["type"], .string("checkpoint.rollback"))
            XCTAssertEqual(step.payload["checkpointId"], .string(expected))
            XCTAssertEqual(step.payload["scopeId"], .string("scope-\(expected)"))
            XCTAssertEqual(step.payload["restoreFiles"], .bool(false))
            XCTAssertNil(step.payload["turnCount"])
        }
        var wrong = intent("thread.checkpoint.revert")
        wrong["checkpointId"] = .string("does-not-exist")
        wrong["scopeId"] = .string("scope-first")
        wrong["turnCount"] = .number(1)
        XCTAssertThrowsError(try OrchestrationV2Commands.plan(.object(wrong), projection: .object(state)))
        let known = OrchestrationV2Commands.rollback(threadID: "thread", scopeID: "scope", checkpointID: "checkpoint", restoreFiles: true, commandID: "rollback")
        XCTAssertFalse(OrchestrationV2Commands.requiresProjection(known, serverResolvedCommandContext: true))
        XCTAssertEqual(try OrchestrationV2Commands.plan(known, serverResolvedCommandContext: true).requests.first?.payload, known)
    }

    func testConversationRollbackUsesThePreviousCheckpointAcrossCancelledRunGaps() throws {
        var state = try object(rollbackProjection())
        state["runs"] = .array(try array(state["runs"]) + [run("cancelled", status: "cancelled", ordinal: 2)])
        let target = try OrchestrationV2Commands.conversationRollbackTarget(beforeRunID: "run-3", projection: .object(state))
        XCTAssertEqual(target.checkpointID, "checkpoint-1")
        XCTAssertEqual(target.scopeID, "scope")
        XCTAssertEqual(target.appRunOrdinal, 1)
        XCTAssertEqual(target.runID, "run-3")
        let command = OrchestrationV2Commands.rollback(threadID: "thread", scopeID: target.scopeID,
            checkpointID: target.checkpointID, restoreFiles: false, commandID: "rollback")
        XCTAssertEqual(try OrchestrationV2Commands.plan(command, projection: .object(state)).requests.first?.payload, command)
        var legacyIntent = intent("thread.conversation.revert")
        legacyIntent["turnCount"] = .number(2)
        XCTAssertEqual(try OrchestrationV2Commands.plan(.object(legacyIntent), projection: .object(state))
            .requests.first?.payload["checkpointId"], .string("checkpoint-1"))
    }

    func testFirstRunRollbackUsesTheGenesisCheckpoint() throws {
        let target = try OrchestrationV2Commands.conversationRollbackTarget(beforeRunID: "run-1", projection: rollbackProjection())
        XCTAssertEqual(target.checkpointID, "genesis")
        XCTAssertEqual(target.scopeID, "scope")
        XCTAssertEqual(target.appRunOrdinal, 0)
    }

    func testRollbackRejectsPendingCheckpointsAndDoesNotSkipThem() throws {
        for id in ["genesis", "checkpoint-1", "checkpoint-3"] {
            var state = try object(rollbackProjection())
            state["checkpoints"] = .array(try array(state["checkpoints"]).map { checkpoint in
                guard checkpoint["id"]?.stringValue == id else { return checkpoint }
                return .object(try object(checkpoint).merging(["status": .string("pending")]) { _, new in new })
            })
            let selectedRun = id == "genesis" ? "run-1" : "run-3"
            XCTAssertThrowsError(try OrchestrationV2Commands.conversationRollbackTarget(beforeRunID: selectedRun, projection: .object(state))) { error in
                XCTAssertTrue(error.localizedDescription.contains("not ready"))
            }
        }
    }

    func testRollbackRejectsProviderHandoffsIncludingGenesis() throws {
        for selectedRun in ["run-1", "run-3"] {
            var state = try object(rollbackProjection())
            if selectedRun == "run-1" {
                state["checkpointScopes"] = .array([.object([
                    "id": .string("scope"), "advancesAppRunCount": .bool(true),
                    "providerThreadId": .string("old-provider-thread"),
                ])])
            } else {
                state["providerTurns"] = .array(try array(state["providerTurns"]).map { turn in
                    guard turn["id"] == .string("turn-1") else { return turn }
                    return .object(try object(turn).merging(["providerThreadId": .string("old-provider-thread")]) { _, new in new })
                })
            }
            XCTAssertThrowsError(try OrchestrationV2Commands.conversationRollbackTarget(beforeRunID: selectedRun, projection: .object(state))) { error in
                XCTAssertEqual(error.localizedDescription, "Cannot rewind across a provider handoff.")
            }
        }
    }

    func testRollbackDoesNotTargetAuditCheckpointsFromRolledBackRuns() throws {
        var state = try object(rollbackProjection(ordinals: [1, 3, 4]))
        state["runs"] = .array(try array(state["runs"]).map { run in
            guard run["id"] == .string("run-3") else { return run }
            return .object(try object(run).merging(["status": .string("rolled_back")]) { _, new in new })
        })
        let target = try OrchestrationV2Commands.conversationRollbackTarget(beforeRunID: "run-4", projection: .object(state))
        XCTAssertEqual(target.checkpointID, "checkpoint-1")
    }

    func testRollbackRejectsUnfinishedWorkAndProviderSubagentThreads() throws {
        for status in ["queued", "preparing", "starting", "running", "waiting"] {
            var state = try object(rollbackProjection())
            state["runs"] = .array(try array(state["runs"]) + [run("pending", status: status, ordinal: 4)])
            XCTAssertThrowsError(try OrchestrationV2Commands.conversationRollbackTarget(beforeRunID: "run-3", projection: .object(state))) { error in
                XCTAssertEqual(error.localizedDescription, "Wait for this thread's work to finish before rewinding.")
            }
        }
        var state = try object(rollbackProjection())
        var thread = try object(state["thread"])
        thread["creationSource"] = .string("provider")
        thread["lineage"] = .object(["relationshipToParent": .string("subagent")])
        state["thread"] = .object(thread)
        XCTAssertThrowsError(try OrchestrationV2Commands.conversationRollbackTarget(beforeRunID: "run-3", projection: .object(state))) { error in
            XCTAssertEqual(error.localizedDescription, "This subagent conversation is read-only.")
        }
    }

    private func rollbackProjection(ordinals: [Int] = [1, 3]) -> JSONValue {
        var state = projection().v2Object
        var thread = state["thread"]!.v2Object
        thread["activeProviderThreadId"] = .string("provider-thread")
        state["thread"] = .object(thread)
        state["runs"] = .array(ordinals.map { ordinal in
            .object(run("run-\(ordinal)", status: "completed", ordinal: ordinal).v2Object.merging([
                "activeAttemptId": .string("attempt-\(ordinal)"), "checkpointId": .string("checkpoint-\(ordinal)"),
            ]) { _, new in new })
        })
        state["attempts"] = .array(ordinals.map { .object([
            "id": .string("attempt-\($0)"), "runId": .string("run-\($0)"), "providerTurnId": .string("turn-\($0)"),
        ]) })
        state["providerTurns"] = .array(ordinals.map { .object([
            "id": .string("turn-\($0)"), "runAttemptId": .string("attempt-\($0)"), "providerThreadId": .string("provider-thread"),
        ]) })
        state["checkpointScopes"] = .array([.object([
            "id": .string("scope"), "advancesAppRunCount": .bool(true), "providerThreadId": .string("provider-thread"),
        ])])
        state["checkpoints"] = .array(([0] + ordinals).map { ordinal in .object([
            "id": .string(ordinal == 0 ? "genesis" : "checkpoint-\(ordinal)"), "scopeId": .string("scope"),
            "status": .string("ready"), "ordinalWithinScope": .number(Double(ordinal)),
            "appRunOrdinal": ordinal == 0 ? .null : .number(Double(ordinal)),
        ]) })
        return .object(state)
    }

    func testQueueOperationsPreserveRunAndMessageIdentities() throws {
        let reorder = OrchestrationV2Commands.reorderQueuedRun(threadID: "thread", runID: "queued", beforeRunID: nil, commandID: "reorder")
        XCTAssertEqual(try OrchestrationV2Commands.plan(reorder).requests.first?.payload["beforeRunId"], .null)
        let cancel = OrchestrationV2Commands.cancelQueuedRun(threadID: "thread", runID: "queued", commandID: "cancel")
        XCTAssertEqual(try OrchestrationV2Commands.plan(cancel).requests.first?.payload["runId"], .string("queued"))
        let held = OrchestrationV2Commands.interruptRun(threadID: "thread", runID: "active", commandID: "hold")
        XCTAssertEqual(try OrchestrationV2Commands.plan(held).requests.first?.payload["holdQueue"], .bool(true))
        let edit = OrchestrationV2Commands.editQueuedRun(threadID: "thread", runID: "queued", text: "Revised", commandID: "edit")
        XCTAssertNil(try OrchestrationV2Commands.plan(edit).requests.first?.payload["attachments"])
        let remove = OrchestrationV2Commands.editQueuedRun(threadID: "thread", runID: "queued", text: "Revised", messageID: "queued-message", attachments: [], commandID: "remove")
        let edited = try XCTUnwrap(OrchestrationV2Commands.plan(remove).requests.first)
        XCTAssertEqual(edited.payload["attachments"], .array([]))
        XCTAssertNil(edited.payload["messageId"])

        let now = OrchestrationV2Commands.sendQueuedRunNow(threadID: "thread", runID: "second", commandID: "now")
        let queued = [run("first", status: "queued", ordinal: 1), run("second", status: "queued", ordinal: 2)]
        let idle = try OrchestrationV2Commands.plan(now, projection: projection(runs: queued))
        XCTAssertEqual(idle.requests.map { $0.payload["type"] }, [.string("queued-run.reorder"), .string("queue.resume")])
        XCTAssertEqual(idle.requests[0].payload["beforeRunId"], .string("first"))
        XCTAssertEqual(idle.requests.map { $0.payload["commandId"] }, [.string("now:reorder"), .string("now:resume")])
        let active = try OrchestrationV2Commands.plan(now, projection: projection(runs: queued + [run("active", status: "running")]))
        XCTAssertEqual(active.requests.count, 1)
        XCTAssertEqual(active.requests[0].payload["type"], .string("queued-message.promote-to-steer"))
        XCTAssertEqual(active.requests[0].payload["queuedRunId"], .string("second"))
        XCTAssertEqual(active.requests[0].payload["targetRunId"], .string("active"))
    }

    func testAttachmentsPersistBeforeDispatchAndRebindContextWithoutChangingOrder() async throws {
        let stored = attachment(id: "stored")
        var upload = try object(attachment(id: "local"))
        upload["dataUrl"] = .string("data:image/png;base64,YQ==")
        var command = turn()
        command["message"] = .object([
            "messageId": .string("message"), "text": .string("Look"), "attachments": .array([stored, .object(upload)]),
            "context": .object(["records": .array([
                .object(["kind": .string("image"), "attachmentId": .string("local"), "contextId": .string("image-context")]),
            ])]),
        ])
        XCTAssertThrowsError(try OrchestrationV2Commands.plan(.object(command), projection: projection(), serverResolvedCommandContext: true)) { error in
            XCTAssertEqual(error as? OrchestrationV2Commands.AdapterError, .attachmentsRequirePersistence)
        }
        let recorder = Recorder(responses: [
            .object(["attachments": .array([attachment(id: "persisted")])]),
            .object(["sequence": .number(5)]), .object(["sequence": .number(6)]), .object(["sequence": .number(7)]),
        ])
        let result = try await OrchestrationV2Commands.execute(.object(command), projection: projection(runtimeMode: "approval-required"), serverResolvedCommandContext: true) {
            try await recorder.respond($0)
        }
        XCTAssertEqual(result.sequence, 7)
        let requests = await recorder.requests
        XCTAssertEqual(requests.first?.method, "assets.persistChatAttachments")
        XCTAssertEqual(requests.first?.payload["messageId"], .string("message"))
        XCTAssertEqual(requests.first?.payload["attachments"], .array([.object(upload)]))
        let sent = try XCTUnwrap(requests.last).payload
        XCTAssertEqual(sent["attachments"], .array([stored, attachment(id: "persisted")]))
        let records = try array(sent["context"]?["records"])
        XCTAssertEqual(records.first?["attachmentId"], .string("persisted"))
        XCTAssertEqual(records.first?["contextId"], .string("image-context"))
        XCTAssertEqual(sent["messageId"], .string("message"))
    }

    func testAttachmentFailureStopsBeforeMessageAndDoesNotDropMissingUploads() async throws {
        var upload = try object(attachment(id: "local"))
        upload["dataUrl"] = .string("data:image/png;base64,YQ==")
        let command = OrchestrationV2Commands.sendTurn(threadID: "thread", text: "Look", runtimeMode: "full-access", interactionMode: "default", attachments: [.object(upload)], commandID: "send", messageID: "message")
        let recorder = Recorder(responses: [.object(["attachments": .array([])])])
        do {
            _ = try await OrchestrationV2Commands.execute(command, projection: projection(), serverResolvedCommandContext: true) { try await recorder.respond($0) }
            XCTFail("Missing persisted uploads must fail.")
        } catch {
            XCTAssertEqual(error as? OrchestrationV2Commands.AdapterError, .invalidResponse("assets.persistChatAttachments"))
        }
        let requests = await recorder.requests
        XCTAssertEqual(requests.count, 1)
    }

    func testUserInputUploadUsesStablePerQuestionPersistenceIdentity() async throws {
        var upload = try object(attachment(id: "local"))
        upload["dataUrl"] = .string("data:image/png;base64,YQ==")
        var command = intent("thread.user-input.respond")
        command["requestId"] = .string("request")
        command["answers"] = .object(["question": .string("")])
        command["attachmentsByQuestionId"] = .object(["question": .array([.object(upload)])])
        let recorder = Recorder(responses: [.object(["attachments": .array([attachment(id: "persisted")])]), .object(["sequence": .number(9)])])
        let result = try await OrchestrationV2Commands.execute(.object(command)) { try await recorder.respond($0) }
        let requests = await recorder.requests
        XCTAssertEqual(requests[0].payload["messageId"], .string("command:answer:question"))
        XCTAssertEqual(requests[1].payload["requestId"], .string("request"))
        XCTAssertEqual(requests[1].payload["attachmentsByQuestionId"]?["question"], .array([attachment(id: "persisted")]))
        XCTAssertEqual(result.sequence, 9)
    }

    func testLaunchAndProjectResponsesDoNotInventSequence() async throws {
        var command = turn()
        command["bootstrap"] = .object(["createThread": projection()["thread"]!])
        let launch = Recorder(responses: [.object(["threadId": .string("thread"), "projection": projection(), "resumed": .bool(false)])])
        let result = try await OrchestrationV2Commands.execute(.object(command)) { try await launch.respond($0) }
        XCTAssertEqual(result.sequence, 0)
        XCTAssertEqual(result.projection, projection())
        XCTAssertNil(result.project)
        let project = JSONValue.object(["id": .string("project"), "title": .string("Project")])
        let mutate = Recorder(responses: [project])
        let changed = try await OrchestrationV2Commands.execute(.object([
            "type": .string("project.delete"), "commandId": .string("delete"), "projectId": .string("project"),
        ])) { try await mutate.respond($0) }
        XCTAssertEqual(changed.sequence, 0)
        XCTAssertEqual(changed.project, project)
    }

    func testSequenceFailureStopsWithoutTryingAnotherProtocol() async throws {
        let command = JSONValue.object(turn())
        let recorder = Recorder(responses: [.object(["sequence": .number(2)])])
        do {
            _ = try await OrchestrationV2Commands.execute(command, projection: projection(), serverResolvedCommandContext: true) { try await recorder.respond($0) }
            XCTFail("The second request must fail.")
        } catch { XCTAssertTrue(error is Recorder.Failure) }
        let requests = await recorder.requests
        XCTAssertEqual(requests.count, 2)
        XCTAssertTrue(requests.allSatisfy { $0.method == "orchestration.dispatchCommand" })
    }

    func testPullRequestAndLifecycleIntentsPreserveFieldsAndRejectUnknownOperations() throws {
        var linked = intent("thread.pull-request.link")
        linked.merge([
            "host": .string("github.com"), "repository": .string("owner/repo"), "number": .number(42),
            "url": .string("https://github.com/owner/repo/pull/42"), "source": .string("manual"),
        ]) { _, new in new }
        XCTAssertEqual(try OrchestrationV2Commands.plan(.object(linked)).requests.first?.payload, .object(linked))
        for (type, fields) in [
            ("thread.archive", [:]), ("thread.unarchive", [:]), ("thread.delete", [:]),
            ("thread.settle", [:]), ("thread.unsettle", ["reason": JSONValue.string("user")]),
            ("thread.snooze", ["snoozedUntil": .string("2026-10-05T00:00:00Z")]),
            ("thread.unsnooze", ["reason": .string("user")]), ("thread.auto-settle.set", ["enabled": .bool(false)]),
            ("thread.pin", ["orderKey": .string("a1")]), ("thread.unpin", [:]),
            ("thread.pin.reorder", ["orderKey": .string("a2")]), ("thread.active.reorder", ["orderKey": .string("a3")]),
            ("thread.visit", ["visitedAt": .string("2026-10-04T00:00:00Z")]), ("thread.mark-unread", [:]),
        ] {
            let command = JSONValue.object(intent(type).merging(fields) { _, new in new })
            XCTAssertEqual(try OrchestrationV2Commands.plan(command).requests.first?.payload, command)
        }
        XCTAssertThrowsError(try OrchestrationV2Commands.plan(.object(intent("queue.hold"))))
        var noID = turn()
        noID.removeValue(forKey: "commandId")
        XCTAssertThrowsError(try OrchestrationV2Commands.plan(.object(noID), serverResolvedCommandContext: true))
        var wrongState = try object(projection())
        wrongState["thread"] = .object(["id": .string("another-thread")])
        XCTAssertThrowsError(try OrchestrationV2Commands.plan(.object(turn()), projection: .object(wrongState)))
    }

    private var model: JSONValue { .object(["instanceId": .string("codex"), "model": .string("model")]) }

    private func intent(_ type: String) -> [String: JSONValue] {
        ["type": .string(type), "commandId": .string("command"), "threadId": .string("thread")]
    }

    private func turn() -> [String: JSONValue] {
        var result = intent("thread.turn.start")
        result["message"] = .object(["messageId": .string("message"), "role": .string("user"), "text": .string("Fix this"), "attachments": .array([])])
        result["runtimeMode"] = .string("full-access")
        result["interactionMode"] = .string("plan")
        result["modelSelection"] = model
        return result
    }

    private func projection(runs: [JSONValue] = [], capabilities: [String: Bool] = [:], runtimeMode: String = "full-access") -> JSONValue {
        .object([
            "thread": .object([
                "id": .string("thread"), "projectId": .string("project"), "title": .string("Thread"),
                "modelSelection": model, "providerInstanceId": .string("codex"),
                "runtimeMode": .string(runtimeMode), "interactionMode": .string("default"),
                "branch": .null, "worktreePath": .null,
            ]),
            "runs": .array(runs), "messages": .array([]), "checkpoints": .array([]),
            "providerSessions": .array([.object([
                "id": .string("session"), "capabilities": .object(["turns": .object(capabilities.mapValues(JSONValue.bool))]),
            ])]),
            "providerThreads": .array([.object(["id": .string("provider-thread"), "providerSessionId": .string("session")])]),
            "providerTurns": .array([]), "attempts": .array([]), "turnItems": .array([]),
        ])
    }

    private func run(_ id: String, status: String, ordinal: Int = 1) -> JSONValue {
        .object(["id": .string(id), "status": .string(status), "providerThreadId": .string("provider-thread"),
                 "ordinal": .number(Double(ordinal)), "userMessageId": .string("message-\(id)")])
    }

    private func checkpoint(_ id: String, ordinal: Int, appOrdinal: Int?) -> JSONValue {
        .object(["id": .string(id), "scopeId": .string("scope-\(id)"), "status": .string("ready"),
                 "ordinalWithinScope": .number(Double(ordinal)), "appRunOrdinal": appOrdinal.map { .number(Double($0)) } ?? .null])
    }

    private func attachment(id: String = "attachment") -> JSONValue {
        .object(["type": .string("image"), "id": .string(id), "name": .string("image.png"), "mimeType": .string("image/png"), "sizeBytes": .number(1)])
    }

    private func object(_ value: JSONValue?) throws -> [String: JSONValue] {
        guard case let .object(result) = value else { throw FixtureError.invalid }
        return result
    }

    private func array(_ value: JSONValue?) throws -> [JSONValue] {
        guard case let .array(result) = value else { throw FixtureError.invalid }
        return result
    }

    private enum FixtureError: Error { case invalid }

    private actor Recorder {
        enum Failure: Error { case noResponse }
        private(set) var requests: [OrchestrationV2Commands.Request] = []
        private var responses: [JSONValue]
        init(responses: [JSONValue]) { self.responses = responses }
        func respond(_ request: OrchestrationV2Commands.Request) throws -> JSONValue {
            requests.append(request)
            guard !responses.isEmpty else { throw Failure.noResponse }
            return responses.removeFirst()
        }
    }
}
