import Foundation
import XCTest
@testable import T3Code

final class OrchestrationV2PresentationTests: XCTestCase {
    func testGoalPresentationUsesProviderAccountingAndActualWorkingState() throws {
        let raw: JSONValue = .object([
            "objective": .string("Ship the fix"), "status": .string("budget_limited"),
            "tokensUsed": .number(12_000), "tokenBudget": .number(50_000), "timeUsedSeconds": .number(240),
        ])
        let goal = try raw.decode(OrchestrationV2ProviderGoal.self)
        let budget = OrchestrationV2Presentation.providerGoal(goal, working: false)
        XCTAssertEqual(budget.title, "Goal reached its token budget")
        XCTAssertEqual(budget.usage, "12k / 50k tokens · 4m")
        XCTAssertTrue(budget.canResume)
        let paused = try V2Fixture.patch(raw, ["status": .string("paused"), "tokenBudget": .null]).decode(OrchestrationV2ProviderGoal.self)
        XCTAssertEqual(OrchestrationV2Presentation.providerGoal(paused, working: false).title, "Goal paused")
        XCTAssertEqual(OrchestrationV2Presentation.providerGoal(paused, working: false).usage, "12k tokens · 4m")
        let claude = try JSONValue.object([
            "objective": .string("Ship the fix"), "status": .string("active"),
            "checks": .number(2), "lastCheck": .string("Tests remain"),
        ]).decode(OrchestrationV2ProviderGoal.self)
        XCTAssertEqual(OrchestrationV2Presentation.providerGoal(claude, working: false).title, "Goal set")
        XCTAssertEqual(OrchestrationV2Presentation.providerGoal(claude, working: true).title, "Pursuing goal")
        XCTAssertEqual(OrchestrationV2Presentation.providerGoal(claude, working: false).usage, "2 checks")
        XCTAssertFalse(OrchestrationV2Presentation.providerGoal(claude, working: false).canResume)
        XCTAssertEqual(claude.lastCheck, "Tests remain")
        for field in ["tokensUsed", "tokenBudget", "timeUsedSeconds", "checks"] {
            XCTAssertThrowsError(try V2Fixture.patch(raw, [field: .number(-1)]).decode(OrchestrationV2ProviderGoal.self))
        }
    }

    func testCompletedDelegateKeepsLineageAndTerminalStatusAcrossShellAndDetail() throws {
        let lineage: JSONValue = .object([
            "parentThreadId": .string("parent"), "rootThreadId": .string("parent"),
            "relationshipToParent": .string("subagent"),
        ])
        let raw = try V2Fixture.load("v2-shell-snapshot")
        let original = try XCTUnwrap(raw["threads"]?.v2Array?.first)
        let child = V2Fixture.patch(original, [
            "lineage": lineage, "creationSource": .string("mcp"),
            "status": .string("completed"), "activeRunId": .null,
            "activityRunStatus": .null, "pendingRuntimeRequest": .null,
            "pendingBackgroundTasks": .array([]),
        ])
        let shell = OrchestrationV2Presentation.shellThread(try OrchestrationV2ThreadShell(json: child))
        XCTAssertEqual(shell.relationshipToParent, "subagent")
        XCTAssertEqual(shell.latestTurn?.state, "completed")
        XCTAssertEqual(shell.session?.status, "ready")
        XCTAssertEqual(NativeFeatureClient.resolveThreadState(
            latestTurn: shell.latestTurn, session: shell.session,
            hasApprovals: false, hasUserInput: false, backgroundLiveness: shell.backgroundLiveness
        ), .completed)
        let base = V2Fixture.snapshot()
        let thread = try XCTUnwrap(base["projection"]?["thread"])
        let snapshot = V2Fixture.projectionPatch(base, [
            "thread": V2Fixture.patch(thread, ["lineage": lineage, "creationSource": .string("mcp")]),
            "runs": .array([V2Fixture.run(status: "completed")]),
        ])
        let detail = try OrchestrationV2ThreadState(snapshot: snapshot).normalizedSnapshot()
        XCTAssertEqual(detail.thread.relationshipToParent, "subagent")
        XCTAssertEqual(detail.thread.session?.status, "ready")
    }

    func testArchiveEndpointUsesItsThreadsArrayWithoutAnArchivedThreadsKey() throws {
        var archived = try V2Fixture.load("v2-shell-snapshot").v2Object
        archived.removeValue(forKey: "archivedThreads")
        let result = try OrchestrationV2Presentation.shellSnapshot(.object(archived))
        XCTAssertEqual(result.threads.map(\.id), ["thread-v2"])
        XCTAssertEqual(result.orchestrationProtocolVersion, 2)
    }

    func testRepositoryEnrichmentOnlyUpdatesMatchingMetadata() throws {
        let raw = try V2Fixture.load("v2-shell-snapshot")
        let snapshot = try OrchestrationV2Presentation.shellSnapshot(raw)
        var project = try XCTUnwrap(snapshot.projects.first)
        project.repositoryIdentity = nil
        let event: JSONValue = .object([
            "kind": .string("snapshot"),
            "resolvedRepositoryIdentityRoots": .array([.string(project.workspaceRoot)]),
            "snapshot": .object([
                "schemaVersion": .number(2), "snapshotSequence": .number(0),
                "projects": .array([try .encode(project)]), "threads": .array([]), "archivedThreads": .array([]),
            ]),
        ])
        guard case let .repositoryIdentitiesUpdated(updates, roots) = OrchestrationV2Presentation.shellStreamItem(event) else {
            return XCTFail("Enrichment cannot replace the shell")
        }
        let merged = OrchestrationV2Presentation.mergingRepositoryIdentities(snapshot.projects, updates: updates, resolvedRoots: roots)
        XCTAssertEqual(merged.map(\.id), snapshot.projects.map(\.id))
        XCTAssertEqual(merged.first?.title, snapshot.projects.first?.title)
        XCTAssertNil(merged.first?.repositoryIdentity)
        XCTAssertEqual(OrchestrationV2Presentation.mergingRepositoryIdentities(snapshot.projects, updates: [], resolvedRoots: roots), snapshot.projects)
    }

    func testRealShellFixtureMapsStatusPendingRequestsAndProtocolVersion() throws {
        let raw = try V2Fixture.load("v2-shell-snapshot")
        let snapshot = try OrchestrationV2Presentation.shellSnapshot(raw)
        XCTAssertEqual(snapshot.orchestrationProtocolVersion, 2)
        XCTAssertEqual(snapshot.snapshotSequence, 100)
        XCTAssertEqual(snapshot.projects.first?.id, "project-v2")
        let thread = try XCTUnwrap(snapshot.threads.first)
        XCTAssertEqual(thread.id, "thread-v2")
        XCTAssertEqual(thread.session?.status, "running")
        XCTAssertTrue(thread.hasPendingApprovals)
        XCTAssertEqual(thread.autoSettleDisabledAt, "2026-08-07T12:00:00.000Z")
        XCTAssertEqual(thread.activeOrderKey, "nm")
        guard case let .snapshot(stream) = OrchestrationV2Presentation.shellStreamItem(try V2Fixture.load("v2-shell-stream-snapshot")) else {
            return XCTFail("Expected a normalized shell snapshot")
        }
        XCTAssertEqual(stream, snapshot)
        for item in try XCTUnwrap(try V2Fixture.load("v2-shell-stream-updates").v2Array) {
            if case .refreshRequired = OrchestrationV2Presentation.shellStreamItem(item) {
                XCTFail("Known shell fixture must map")
            }
        }
    }

    func testUnknownAndMalformedShellUpdatesRequestRefresh() {
        for raw: JSONValue in [
            .object(["kind": .string("future-update"), "sequence": .number(2)]),
            .object(["kind": .string("thread.updated"), "location": .string("active"), "sequence": .number(2), "thread": .object(["id": .string("broken")])]),
        ] {
            guard case .refreshRequired = OrchestrationV2Presentation.shellStreamItem(raw) else {
                return XCTFail("Expected refresh")
            }
        }
    }

    func testRealDetailRetainsAttachmentsControlStateAndNativeRequestActivities() throws {
        let state = try OrchestrationV2ThreadState(snapshot: V2Fixture.load("v2-thread-bounded-snapshot"))
        let detail = state.normalizedSnapshot()
        XCTAssertEqual(detail.orchestrationProtocolVersion, 2)
        XCTAssertEqual(detail.page?.beforeCursor, "fixture-v2-before-10")
        XCTAssertEqual(detail.page?.threadSequence, 100)
        XCTAssertTrue(detail.page?.hasMore == true)
        let controls = try XCTUnwrap(detail.thread.orchestrationV2Control)
        XCTAssertEqual(controls["runs"]?.v2Array?.count, 3)
        XCTAssertEqual(controls["providerSessions"]?.v2Array?.count, 1)
        XCTAssertNotNil(controls["providerThreads"])
        XCTAssertNotNil(controls["providerTurns"])
        XCTAssertNotNil(controls["attempts"])
        XCTAssertNil(controls["turnItems"])
        let assistantSources = try XCTUnwrap(controls["visibleTurnItems"]?.v2Array)
        XCTAssertTrue(assistantSources.allSatisfy { $0["item"]?["type"] == .string("assistant_message") && $0["item"]?["text"] == nil })
        XCTAssertTrue(detail.thread.messages.contains { $0.attachments?.isEmpty == false })
        XCTAssertFalse(detail.thread.messages.contains { $0.id == "message-v2-queued" })
        XCTAssertTrue(detail.thread.activities.contains { $0.kind == "approval.requested" && $0.payload["requestId"] == .string("request-v2-approval") })
        XCTAssertTrue(detail.thread.activities.contains { $0.kind == "user-input.requested" && $0.payload["requestId"] == .string("request-v2-input") })
        XCTAssertFalse(detail.thread.checkpoints.isEmpty)
        XCTAssertEqual(detail.thread.latestTurn?.turnId, "run-v2-active")
    }

    func testApprovalAndInputResolveUsingStableNativeActivityIDs() throws {
        let approval = V2Fixture.item("approval", type: "approval_request", ordinal: 1, fields: [
            "requestId": .string("approve"), "requestKind": .string("mcp-elicitation"), "prompt": .string("Allow access?"),
            "appName": .string("Drive"), "options": .array([.object(["decision": .string("accept"), "label": .string("Allow")])]),
        ])
        let question = V2Fixture.item("question", type: "user_input_request", ordinal: 2, fields: [
            "requestId": .string("input"), "responseMode": .string("message"),
            "questions": .array([.object(["id": .string("scope"), "header": .string("Scope"), "question": .string("Which files?"), "options": .array([]), "allowCustomAnswer": .bool(true)])]),
        ])
        var state = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot(items: [approval, question], fields: [
            "runtimeRequests": .array([V2Fixture.request("approve", kind: "mcp-elicitation"), V2Fixture.request("input", kind: "user_input", response: "message")]),
        ]))
        let initial = state.normalizedSnapshot().thread.activities
        XCTAssertEqual(initial.map(\.kind), ["approval.requested", "user-input.requested"])
        XCTAssertEqual(initial[0].payload["appName"], .string("Drive"))
        XCTAssertEqual(initial[0].payload["options"]?.v2Array?.count, 1)
        XCTAssertEqual(initial[1].payload["responseMode"], .string("message"))
        _ = state.apply([
            V2Fixture.event("runtime-request.updated", payload: V2Fixture.request("approve", kind: "mcp-elicitation", status: "resolved"), sequence: 11),
            V2Fixture.event("runtime-request.updated", payload: V2Fixture.request("input", kind: "user_input", status: "cancelled", response: "message"), sequence: 12),
        ])
        let final = state.normalizedSnapshot().thread.activities
        XCTAssertEqual(final.map(\.id), initial.map(\.id))
        XCTAssertEqual(final.map(\.kind), ["approval.resolved", "user-input.resolved"])
    }

    func testInheritedRequestsStayReadOnlyAndNonResumableRequestsStayPending() throws {
        let item = V2Fixture.item("approval", type: "approval_request", ordinal: 1, fields: ["requestId": .string("approve"), "requestKind": .string("command")])
        let inherited = V2Fixture.patch(item, ["id": .string("parent-approval"), "threadId": .string("parent")])
        let snapshot = V2Fixture.snapshot(items: [item], fields: [
            "visibleTurnItems": .array([V2Fixture.row(inherited, visibility: "inherited"), V2Fixture.row(item, position: 1)]),
            "runtimeRequests": .array([V2Fixture.request("approve", response: "not_resumable")]),
        ])
        let state = try OrchestrationV2ThreadState(snapshot: snapshot)
        let activities = state.normalizedSnapshot().thread.activities
        XCTAssertEqual(activities.count, 2)
        XCTAssertEqual(activities.first?.kind, "approval.resolved")
        XCTAssertEqual(activities.first?.v2Timeline?.visibility, "inherited")
        XCTAssertNotEqual(activities.first?.payload["requestId"], .string("approve"))
        XCTAssertEqual(activities.last?.kind, "approval.requested")
        XCTAssertEqual(activities.last?.payload["responseCapability"]?["type"], .string("not_resumable"))
    }

    func testQuestionAnswerResolutionKeepsTextSelectionsAndAttachmentsAcrossLiveUpdates() throws {
        let attachments: JSONValue = .object(["scope": .array([
            .object(["type": .string("image"), "id": .string("image"), "name": .string("reference.png"),
                     "mimeType": .string("image/png"), "sizeBytes": .number(512)]),
            .object(["type": .string("file"), "id": .string("file"), "name": .string("notes.txt"),
                     "mimeType": .string("text/plain"), "sizeBytes": .number(64)]),
        ])])
        let answers: JSONValue = .object([
            "scope": .array([.string("Server"), .string("Web")]), "detail": .string("Keep the existing behavior"),
        ])
        let questions: JSONValue = .array([
            .object(["id": .string("scope"), "header": .string("Scope"), "question": .string("Which parts?"), "options": .array([])]),
            .object(["id": .string("detail"), "header": .string("Detail"), "question": .string("Any constraints?"), "options": .array([])]),
        ])
        for response in ["live", "message", "not_resumable"] {
            let question = V2Fixture.item("question", type: "user_input_request", ordinal: 1, fields: [
                "requestId": .string("input"), "questions": questions,
                "responseMode": response == "message" ? .string("message") : .null,
            ])
            var state = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot(items: [question], fields: [
                "runtimeRequests": .array([V2Fixture.request("input", kind: "user_input", response: response)]),
            ]))
            let requestID = try XCTUnwrap(state.normalizedSnapshot().thread.activities.first?.id)
            let resolved = V2Fixture.patch(V2Fixture.request("input", kind: "user_input", status: "resolved", response: response), ["answers": answers])
            // Older servers only stored request.answers; the live request event
            // also arrives before the turn-item event on current servers.
            XCTAssertFalse(state.apply([V2Fixture.event("runtime-request.updated", payload: resolved, sequence: 11)]).refreshRequired)
            let earlyAnswer = try XCTUnwrap(state.normalizedSnapshot().thread.activities.first { $0.kind == "user-input.answer-submitted" })
            XCTAssertEqual(earlyAnswer.payload["answers"], answers)
            XCTAssertEqual(earlyAnswer.payload["attachmentsByQuestionId"], .object([:]))

            let answered = V2Fixture.patch(question, [
                "status": .string("completed"), "completedAt": .string("2026-09-01T12:01:00.000Z"),
                "questionAnswer": .object([
                    "requestId": .string("input"), "answers": answers, "attachmentsByQuestionId": attachments,
                    "questionTextById": .object(["scope": .string("Which parts did you choose?")]),
                ]),
            ])
            XCTAssertFalse(state.apply([V2Fixture.event("turn-item.updated", payload: answered, sequence: 12)]).refreshRequired)
            let activities = state.normalizedSnapshot().thread.activities
            XCTAssertEqual(activities.map(\.kind), ["user-input.resolved", "user-input.answer-submitted"])
            XCTAssertEqual(activities.first?.id, requestID)
            let answer = try XCTUnwrap(activities.last)
            XCTAssertEqual(answer.id, earlyAnswer.id)
            XCTAssertNotEqual(answer.id, requestID)
            XCTAssertEqual(answer.createdAt, "2026-09-01T12:01:00.000Z")
            XCTAssertEqual(answer.payload["answers"], answers)
            XCTAssertEqual(answer.payload["attachmentsByQuestionId"], attachments)
            XCTAssertEqual(answer.payload["questionTextById"]?["scope"], .string("Which parts did you choose?"))
            XCTAssertEqual(answer.payload["questionTextById"]?["detail"], .string("Any constraints?"))
            let files = try XCTUnwrap(answer.payload["attachmentsByQuestionId"]?["scope"]).decode([ChatAttachment].self)
            XCTAssertEqual(files.map(\.id), ["image", "file"])
            let loaded = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot(items: [answered], fields: ["runtimeRequests": .array([resolved])]))
            XCTAssertEqual(loaded.normalizedSnapshot().thread.activities, activities)

            _ = state.apply([V2Fixture.event("runtime-request.updated", payload: V2Fixture.request("input", kind: "user_input", status: "resolved", response: response), sequence: 13)])
            XCTAssertEqual(state.normalizedSnapshot().thread.activities, activities)
        }
    }

    func testInheritedQuestionsKeepReadOnlyHistoryAndNonResumableLocalQuestionsStayPending() throws {
        for response in ["live", "message", "not_resumable"] {
            let question = V2Fixture.item("question", type: "user_input_request", ordinal: 1, fields: [
                "requestId": .string("input"), "questions": .array([]),
            ])
            let inherited = V2Fixture.patch(question, ["threadId": .string("parent")])
            let answer = V2Fixture.patch(inherited, ["id": .string("answered"), "requestId": .string("answered-input"), "questionAnswer": .object([
                "requestId": .string("answered-input"), "answers": .object(["scope": .string("Server")]),
                "attachmentsByQuestionId": .object([:]), "questionTextById": .object(["scope": .string("Which parts?")]),
            ])])
            let state = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot(items: [question], fields: [
                "visibleTurnItems": .array([V2Fixture.row(inherited, visibility: "inherited"),
                                            V2Fixture.row(answer, visibility: "inherited", position: 1), V2Fixture.row(question, position: 2)]),
                "runtimeRequests": .array([V2Fixture.request("input", kind: "user_input", response: response)]),
            ]))
            let activities = state.normalizedSnapshot().thread.activities
            XCTAssertEqual(activities.count, 4)
            let savedAnswer = try XCTUnwrap(activities.first { $0.kind == "user-input.answer-submitted" })
            XCTAssertEqual(savedAnswer.payload["answers"]?["scope"], .string("Server"))
            XCTAssertTrue(savedAnswer.id.contains("inherited"))
            XCTAssertFalse(activities.filter { $0.v2Timeline?.visibility == "inherited" }.contains { $0.kind == "user-input.requested" })
            XCTAssertEqual(activities.last?.kind, "user-input.requested")
            XCTAssertEqual(activities.last?.payload["responseCapability"]?["type"], .string(response))
        }
    }

    func testBackgroundControlMetadataTracksItemsOutsideVisibleHistoryWithoutToolOutput() throws {
        let item = V2Fixture.item("background", type: "command_execution", ordinal: 1, fields: [
            "input": .string("long task"), "output": .string("Large output"),
        ])
        var state = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot(fields: ["turnItems": .array([item])]))
        let controls = try XCTUnwrap(state.normalizedSnapshot().thread.orchestrationV2Control)
        XCTAssertTrue(state.normalizedSnapshot().thread.activities.isEmpty)
        let background = try XCTUnwrap(controls["backgroundTurnItems"]?.v2Array?.first)
        XCTAssertEqual(background["status"], .string("running"))
        XCTAssertEqual(background["runId"], .string("run"))
        XCTAssertNil(background["input"])
        XCTAssertNil(background["output"])
        _ = state.apply([V2Fixture.event("turn-item.updated", payload: V2Fixture.patch(item, ["status": .string("completed")]), sequence: 11)])
        XCTAssertEqual(state.normalizedSnapshot().thread.orchestrationV2Control?["backgroundTurnItems"]?.v2Array?.first?["status"], .string("completed"))
    }

    func testToolUpdatesRetainOutputAndFailureToneWithoutDuplicateRows() throws {
        let command = V2Fixture.item("tool", type: "command_execution", ordinal: 1, fields: ["input": .string("swift test"), "output": .string("Running")])
        var state = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot(items: [command]))
        let start = try XCTUnwrap(state.normalizedSnapshot().thread.activities.first)
        XCTAssertEqual(start.kind, "tool.updated")
        XCTAssertEqual(start.payload["status"], .string("inProgress"))
        let finished = V2Fixture.patch(command, ["status": .string("failed"), "output": .string("1 test failed"), "exitCode": .number(1)])
        let result = state.apply([V2Fixture.event("turn-item.updated", payload: finished, sequence: 11)])
        XCTAssertFalse(result.requiresTimelineRebuild)
        let activities = state.normalizedSnapshot().thread.activities
        XCTAssertEqual(activities.count, 1)
        XCTAssertEqual(activities.first?.id, start.id)
        XCTAssertEqual(activities.first?.tone, "error")
        XCTAssertEqual(activities.first?.payload["output"], .string("1 test failed"))
        XCTAssertEqual(activities.first?.payload["toolCallId"], .string("tool"))
    }

    func testReasoningPlansFailureAndHandoffProduceVisibleNativeContent() throws {
        let items = [
            V2Fixture.item("reason", type: "reasoning", ordinal: 1, fields: ["text": .string("Checking the state"), "streaming": .bool(true)]),
            V2Fixture.item("plan", type: "proposed_plan", ordinal: 2, fields: ["planId": .string("plan"), "markdown": .string("## Fix\nUse the reducer"), "streaming": .bool(false)]),
            V2Fixture.item("error", type: "error", ordinal: 3, fields: ["status": .string("failed"), "failure": .object(["class": .string("provider_error"), "message": .string("Provider stopped"), "code": .null, "retryable": .bool(true)])]),
            V2Fixture.item("handoff", type: "handoff", ordinal: 4, fields: ["contextHandoffId": .string("handoff"), "fromProviderThreadIds": .array([]), "toProviderThreadId": .string("next"), "fromProviderInstanceIds": .array([]), "toProviderInstanceId": .string("claude"), "strategy": .string("full_thread_summary"), "summary": .string("Continue with the checked state")]),
        ]
        let state = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot(items: items))
        let detail = state.normalizedSnapshot().thread
        XCTAssertEqual(detail.messages.map(\.role), ["assistant"])
        XCTAssertTrue(detail.activities.contains { $0.v2Item?["text"] == .string("Checking the state") })
        XCTAssertTrue(detail.activities.contains { $0.v2Item?["summary"] == .string("Continue with the checked state") })
        let failure = try XCTUnwrap(detail.activities.first { $0.v2Timeline?.itemType == "error" })
        XCTAssertEqual(failure.tone, "error")
        XCTAssertEqual(failure.payload["message"], .string("Provider stopped"))
        XCTAssertEqual(detail.v2Timeline?.count, 4)
    }

    func testSubagentControlUpdateClosesItsWorkLogAndPreservesUniqueActivityIDs() throws {
        let agent: JSONValue = .object([
            "id": .string("agent"), "threadId": .string("thread"), "runId": .string("run"),
            "parentNodeId": .string("root"), "origin": .string("app_owned"), "createdBy": .string("agent"),
            "driver": .string("codex"), "providerInstanceId": .string("codex"), "providerThreadId": .null,
            "childThreadId": .string("child"), "nativeTaskRef": .null, "prompt": .string("Check the reducer"),
            "title": .string("Review"), "model": .null, "status": .string("running"), "result": .null,
            "startedAt": .string(V2Fixture.now), "completedAt": .null, "updatedAt": .string(V2Fixture.now),
        ])
        let item = V2Fixture.item("agent-item", type: "subagent", ordinal: 1, fields: [
            "subagentId": .string("agent"), "origin": .string("app_owned"), "driver": .string("codex"),
            "providerInstanceId": .string("codex"), "childThreadId": .string("child"),
            "prompt": .string("Check the reducer"), "result": .null,
        ])
        var state = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot(items: [item], fields: ["subagents": .array([agent])]))
        let finished = V2Fixture.patch(agent, ["status": .string("completed"), "result": .string("Verified")])
        XCTAssertFalse(state.apply([V2Fixture.event("subagent.updated", payload: finished, sequence: 11)]).refreshRequired)
        let activities = state.normalizedSnapshot().thread.activities
        XCTAssertEqual(Set(activities.map(\.id)).count, activities.count)
        XCTAssertTrue(activities.contains { $0.kind == "task.updated" && $0.payload["status"] == .string("completed") })
        XCTAssertTrue(activities.contains {
            $0.kind == "tool.updated" && $0.payload["status"] == .string("completed")
                && $0.payload["detail"] == .string("Verified")
        })
        XCTAssertFalse(activities.contains { $0.payload["status"] == .string("inProgress") })
    }

    func testHeldQueueDoesNotReplaceCompletedOutcomeAndHeldOnlyThreadStaysIdle() throws {
        let completed = V2Fixture.patch(V2Fixture.run(status: "completed"), ["completedAt": .string(V2Fixture.now)])
        let held = V2Fixture.patch(V2Fixture.run("held", status: "queued", ordinal: 2), ["queueHeld": .bool(true)])
        let state = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot(fields: ["runs": .array([completed, held])]))
        XCTAssertEqual(state.normalizedSnapshot().thread.latestTurn?.turnId, "run")
        XCTAssertEqual(state.normalizedSnapshot().thread.latestTurn?.state, "completed")
        XCTAssertEqual(state.normalizedSnapshot().thread.session?.status, "ready")
        let onlyHeld = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot(fields: ["runs": .array([held])]))
        XCTAssertNil(onlyHeld.normalizedSnapshot().thread.latestTurn)
        XCTAssertEqual(onlyHeld.normalizedSnapshot().thread.session?.status, "ready")
    }

    func testUsageLimitOutcomeSurvivesNewerQueuedAndUnstartedCancelledRuns() throws {
        let failed = V2Fixture.patch(V2Fixture.run(status: "failed"), ["completedAt": .string(V2Fixture.now)])
        let error = V2Fixture.item("limit", type: "error", ordinal: 1, fields: ["status": .string("failed"), "failure": .object([
            "class": .string("usage_limit"), "message": .string("Limit reached"), "code": .null, "retryable": .bool(true),
        ])])
        for followup in [V2Fixture.run("next", status: "queued", ordinal: 2),
                         V2Fixture.patch(V2Fixture.run("next", status: "cancelled", ordinal: 2), ["startedAt": .null])] {
            let state = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot(items: [error], fields: ["runs": .array([failed, followup])]))
            XCTAssertEqual(state.normalizedSnapshot().thread.latestTurn?.turnId, "run")
            XCTAssertEqual(state.normalizedSnapshot().thread.session?.status, "error")
            XCTAssertEqual(state.normalizedSnapshot().thread.session?.lastError, "Limit reached")
        }
        let session = V2Fixture.patch(V2Fixture.session("session"), ["lastError": .string("Disconnected")])
        let differentError = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot(items: [error], fields: [
            "runs": .array([failed, V2Fixture.run("next", status: "queued", ordinal: 2)]), "providerSessions": .array([session]),
        ]))
        XCTAssertEqual(differentError.normalizedSnapshot().thread.latestTurn?.turnId, "next")
        XCTAssertEqual(differentError.normalizedSnapshot().thread.session?.lastError, "Disconnected")
    }

    func testProviderNativeSubagentUsesRunlessRootStatusWithoutInventingRunnableControl() throws {
        let child = V2Fixture.patch(V2Fixture.thread, ["creationSource": .string("provider"), "lineage": .object([
            "parentThreadId": .string("parent"), "relationshipToParent": .string("subagent"), "rootThreadId": .string("parent"),
        ])])
        let root: JSONValue = .object([
            "id": .string("child-root"), "threadId": .string("thread"), "runId": .null, "parentNodeId": .null,
            "rootNodeId": .string("child-root"), "kind": .string("root_turn"), "status": .string("running"), "countsForRun": .bool(false),
            "providerThreadId": .null, "providerTurnId": .null, "nativeItemRef": .null, "runtimeRequestId": .null,
            "checkpointScopeId": .null, "startedAt": .string(V2Fixture.now), "completedAt": .null,
        ])
        var state = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot(fields: ["thread": child, "nodes": .array([root])]))
        XCTAssertEqual(state.normalizedSnapshot().thread.session?.status, "running")
        XCTAssertEqual(state.normalizedSnapshot().thread.latestTurn?.startedAt, V2Fixture.now)
        XCTAssertNil(state.normalizedSnapshot().thread.session?.activeTurnId)
        XCTAssertEqual(state.normalizedSnapshot().thread.orchestrationV2Control?["runs"], .array([]))
        let completed = V2Fixture.patch(root, ["status": .string("completed"), "completedAt": .string(V2Fixture.now)])
        XCTAssertFalse(state.apply([V2Fixture.event("node.updated", payload: completed, sequence: 11)]).refreshRequired)
        XCTAssertEqual(state.normalizedSnapshot().thread.latestTurn?.state, "completed")
        XCTAssertEqual(state.normalizedSnapshot().thread.session?.status, "ready")
        let regular = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot(fields: ["nodes": .array([root])]))
        XCTAssertNil(regular.normalizedSnapshot().thread.latestTurn)
        XCTAssertEqual(regular.normalizedSnapshot().thread.session?.status, "ready")
    }

    func testRollbackFailureAndProviderUsageReachNativeActivities() throws {
        let thread = V2Fixture.patch(V2Fixture.thread, ["rollbackFailure": .object([
            "requestId": .string("rollback"), "message": .string("Checkpoint missing"),
        ])])
        let turn = V2Fixture.providerTurn(usage: .object(["usedTokens": .number(4321), "updatedAt": .string(V2Fixture.now)]))
        let state = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot(fields: ["thread": thread, "providerTurns": .array([turn])]))
        let activities = state.normalizedSnapshot().thread.activities
        let failure = try XCTUnwrap(activities.first { $0.kind == "checkpoint.revert.failed" })
        XCTAssertEqual(failure.payload["requestId"], .string("rollback"))
        XCTAssertEqual(failure.payload["detail"], .string("Checkpoint missing"))
        XCTAssertEqual(failure.tone, "error")
        XCTAssertEqual(activities.first { $0.kind == "token-usage" }?.payload["usedTokens"], .number(4321))
    }

    func testQueueRowsAppearOnlyAfterStartingAndActiveRunWinsOverQueuedRun() throws {
        let active = V2Fixture.run()
        let queued = V2Fixture.patch(V2Fixture.run("queue", status: "queued", ordinal: 2), ["queueHeld": .bool(true), "queuePosition": .number(1)])
        let message = V2Fixture.user("queued", ordinal: 1, intent: "queued_turn", runID: "queue")
        var state = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot(items: [message], fields: ["runs": .array([active, queued])]))
        XCTAssertTrue(state.normalizedSnapshot().thread.messages.isEmpty)
        XCTAssertEqual(state.normalizedSnapshot().thread.latestTurn?.turnId, "run")
        XCTAssertEqual(state.projection.queuedRuns.first?.queueHeld, true)
        _ = state.apply([V2Fixture.event("run.updated", payload: V2Fixture.patch(queued, ["status": .string("starting")]), sequence: 11)])
        XCTAssertEqual(state.normalizedSnapshot().thread.messages.count, 1)
    }
}
