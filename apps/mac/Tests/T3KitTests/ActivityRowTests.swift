import Testing

@testable import T3Kit

@Suite("ActivityRows derivation")
struct ActivityRowTests {
    private func activity(
        id: String = "a1", tone: OrchestrationThreadActivityTone = .tool, kind: String,
        summary: String, payload: JSONValue = .null
    ) -> OrchestrationThreadActivity {
        OrchestrationThreadActivity(
            id: id, tone: tone, kind: kind, summary: summary, payload: payload,
            createdAt: "2026-07-04T10:00:00.000Z")
    }

    // MARK: Lifecycle noise

    @Test func toolStartedIsSkipped() {
        let row = ActivityRows.row(
            for: activity(kind: "tool.started", summary: "Read started"))
        #expect(row == nil)
    }

    @Test func taskLifecycleIsSkippedByGenericMapper() {
        #expect(
            ActivityRows.row(
                for: activity(
                    tone: .info, kind: "task.started", summary: "local_agent task started"))
                == nil)
        #expect(
            ActivityRows.row(
                for: activity(
                    tone: .info, kind: "task.progress", summary: "Reasoning update",
                    payload: .object(["taskId": .string("task-1")])))
                == nil)
        #expect(
            ActivityRows.row(
                for: activity(
                    tone: .info, kind: "task.completed", summary: "Task completed",
                    payload: .object(["taskId": .string("task-1")])))
                == nil)
    }

    @Test func checkpointCapturedNoticeIsSkipped() {
        let row = ActivityRows.row(
            for: activity(tone: .info, kind: "checkpoint", summary: "Checkpoint captured"))
        #expect(row == nil)
    }

    @Test func noContentRuntimeWarningIsSkipped() {
        let row = ActivityRows.row(
            for: activity(
                tone: .info, kind: "runtime.warning",
                summary: "Claude system message 'commands_changed' (no displayable text content)"))
        #expect(row == nil)
    }

    @Test func processStderrRuntimeWarningIsSkipped() {
        let row = ActivityRows.row(
            for: activity(
                tone: .info, kind: "runtime.warning",
                summary: "The filename or extension is too long. (os error 206)",
                payload: .object([
                    "message": .string("The filename or extension is too long. (os error 206)"),
                    "source": .string("process/stderr"),
                ])))
        #expect(row == nil)
    }

    @Test func processStderrRuntimeErrorIsSkipped() {
        let row = ActivityRows.row(
            for: activity(
                tone: .error, kind: "runtime.error",
                summary: "failed to connect to websocket",
                payload: .object([
                    "message": .string("failed to connect to websocket"),
                    "source": .string("process/stderr"),
                ])))
        #expect(row == nil)
    }

    @Test func runtimeErrorWithoutProcessStderrRemainsVisible() {
        let row = ActivityRows.row(
            for: activity(
                tone: .error, kind: "runtime.error", summary: "Usage limit reached",
                payload: .object(["message": .string("Usage limit reached")])))
        #expect(
            row == .tool(
                id: "a1", title: "Usage limit reached", detail: "Usage limit reached",
                itemType: nil, phase: .failed, output: nil, outputIsError: false))
    }

    @Test func runtimeWarningWithPreviewKeepsNoticeRow() {
        let row = ActivityRows.row(
            for: activity(
                tone: .info, kind: "runtime.warning",
                summary: "Claude system message 'mystery' — detail: something odd"))
        #expect(row == .notice(id: "a1", text: "Claude system message 'mystery' — detail: something odd"))
    }

    // MARK: Tool lifecycle

    @Test func toolUpdatedUsesSummaryAsTitleAndPayloadDetail() {
        let row = ActivityRows.row(
            for: activity(
                kind: "tool.updated", summary: "Read",
                payload: .object([
                    "itemType": .string("file_read"),
                    "status": .string("inProgress"),
                    "detail": .string("Sources/App/Main.swift"),
                ])))
        #expect(
            row == .tool(
                id: "a1", title: "Read", detail: "Sources/App/Main.swift",
                itemType: "file_read", phase: .running, output: nil, outputIsError: false))
    }

    @Test func skillPresentationDrivesTitleAndDetail() {
        // The adapter types a Skill call as a generic dynamic tool; only the
        // server-derived presentation knows it is a skill.
        let row = ActivityRows.row(
            for: activity(
                kind: "tool.completed", summary: "Tool call",
                payload: .object([
                    "itemType": .string("dynamic_tool_call"),
                    "status": .string("completed"),
                    "presentation": .object([
                        "surface": .string("skill"),
                        "title": .string("Skill: cavecrew"),
                        "subtitle": .string("review the diff"),
                        "state": .string("succeeded"),
                        "provenance": .object([
                            "origin": .string("plugin"),
                            "pluginName": .string("caveman"),
                            "skillName": .string("cavecrew"),
                        ]),
                        "inputs": .array([]),
                    ]),
                ])))
        #expect(
            row == .tool(
                id: "a1", title: "Skill: cavecrew", detail: "review the diff",
                itemType: "dynamic_tool_call", phase: .succeeded, output: nil,
                outputIsError: false))
    }

    @Test func presentationStateDrivesPhaseForFailedTools() {
        let row = ActivityRows.row(
            for: activity(
                kind: "tool.completed", summary: "MCP tool call",
                payload: .object([
                    "itemType": .string("mcp_tool_call"),
                    "presentation": .object([
                        "surface": .string("mcp"),
                        "title": .string("linear · create_issue"),
                        "state": .string("failed"),
                        "provenance": .object([
                            "origin": .string("mcp"), "serverName": .string("linear"),
                        ]),
                        "inputs": .array([]),
                    ]),
                ])))
        #expect(
            row == .tool(
                id: "a1", title: "linear · create_issue", detail: "", itemType: "mcp_tool_call",
                phase: .failed, output: nil, outputIsError: false))
    }

    @Test func fileChangePrefersStructuredDetailOverPresentationSubtitle() {
        // The structured `"<Tool>: {json}"` detail is what ToolDetailParsing
        // turns into an inline diff; the presentation subtitle (a bare path)
        // must not replace it.
        let row = ActivityRows.row(
            for: activity(
                kind: "tool.completed", summary: "File change",
                payload: .object([
                    "itemType": .string("file_change"),
                    "data": .object([
                        "toolName": .string("Edit"),
                        "input": .object([
                            "file_path": .string("Sources/App/Main.swift"),
                            "old_string": .string("a"),
                            "new_string": .string("b"),
                        ]),
                    ]),
                    "presentation": .object([
                        "surface": .string("file_change"),
                        "title": .string("Changed files"),
                        "subtitle": .string("Sources/App/Main.swift"),
                        "state": .string("succeeded"),
                        "provenance": .object(["origin": .string("builtin")]),
                        "inputs": .array([]),
                    ]),
                ])))
        guard case .tool(_, let title, let detail, _, _, _, _) = row else {
            Issue.record("expected a tool row")
            return
        }
        #expect(title == "Changed files")
        #expect(detail.hasPrefix("Edit: {"))
        #expect(detail.contains("\"new_string\":\"b\""))
    }

    @Test func toolLifecycleSharesRowIdViaToolCallId() {
        let updated = ActivityRows.row(
            for: activity(
                id: "a1", kind: "tool.updated", summary: "Bash",
                payload: .object([
                    "itemType": .string("command_execution"),
                    "data": .object(["toolCallId": .string("call-7")]),
                ])))
        let completed = ActivityRows.row(
            for: activity(
                id: "a2", kind: "tool.completed", summary: "Bash",
                payload: .object([
                    "itemType": .string("command_execution"),
                    "data": .object(["toolCallId": .string("call-7")]),
                ])))
        #expect(
            updated == .tool(
                id: "tool:call-7", title: "Bash", detail: "",
                itemType: "command_execution", phase: .running, output: nil, outputIsError: false))
        #expect(
            completed == .tool(
                id: "tool:call-7", title: "Bash", detail: "",
                itemType: "command_execution", phase: .succeeded, output: nil, outputIsError: false))
    }

    @Test func toolCompletedStripsExitCodeMarkerAndCompletedSuffix() {
        let row = ActivityRows.row(
            for: activity(
                kind: "tool.completed", summary: "Terminal completed",
                payload: .object([
                    "itemType": .string("command_execution"),
                    "detail": .string("swift build <exited with exit code 0>"),
                ])))
        #expect(
            row == .tool(
                id: "a1", title: "Terminal", detail: "swift build",
                itemType: "command_execution", phase: .succeeded, output: nil, outputIsError: false))
    }

    @Test func toolFailureStatusMapsToFailedPhase() {
        let row = ActivityRows.row(
            for: activity(
                kind: "tool.updated", summary: "Edit",
                payload: .object(["status": .string("failed")])))
        #expect(
            row == .tool(
                id: "a1", title: "Edit", detail: "", itemType: nil, phase: .failed,
                output: nil, outputIsError: false))
    }

    @Test func emptySummaryFallsBackToHumanizedItemType() {
        let row = ActivityRows.row(
            for: activity(
                kind: "tool.updated", summary: "",
                payload: .object(["itemType": .string("web_search")])))
        #expect(
            row == .tool(
                id: "a1", title: "Web search", detail: "", itemType: "web_search",
                phase: .running, output: nil, outputIsError: false))
    }

    @Test func detailDuplicatingTitleIsDropped() {
        let row = ActivityRows.row(
            for: activity(
                kind: "tool.completed", summary: "Read file",
                payload: .object(["detail": .string("  read   FILE ")])))
        #expect(
            row == .tool(
                id: "a1", title: "Read file", detail: "", itemType: nil, phase: .succeeded,
                output: nil, outputIsError: false))
    }

    @Test func planBoundaryToolActivityIsSkipped() {
        let row = ActivityRows.row(
            for: activity(
                kind: "tool.completed", summary: "ExitPlanMode",
                payload: .object([
                    "detail": .string("ExitPlanMode: plan approved"),
                ])))
        #expect(row == nil)
    }

    @Test func fileChangeDetailIsRebuiltFromUntruncatedData() {
        // payload.detail is truncated server-side (~180 chars); the full tool
        // input in payload.data must win so diffs render complete edits.
        let row = ActivityRows.row(
            for: activity(
                kind: "tool.completed", summary: "Edit",
                payload: .object([
                    "itemType": .string("file_change"),
                    "detail": .string("Edit: {\"file_path\": \"a.swift\", \"old_st"),
                    "data": .object([
                        "toolName": .string("Edit"),
                        "input": .object([
                            "file_path": .string("a.swift"),
                            "old_string": .string("let x = 1"),
                            "new_string": .string("let x = 2"),
                        ]),
                    ]),
                ])))
        let expectedDetail =
            #"Edit: {"file_path":"a.swift","new_string":"let x = 2","old_string":"let x = 1"}"#
        #expect(
            row == .tool(
                id: "a1", title: "Edit", detail: expectedDetail, itemType: "file_change",
                phase: .succeeded, output: nil, outputIsError: false))
    }

    @Test func commandDetailIsRebuiltFromUntruncatedData() {
        let row = ActivityRows.row(
            for: activity(
                kind: "tool.completed", summary: "Bash",
                payload: .object([
                    "itemType": .string("command_execution"),
                    "detail": .string("Bash: swift build --package-pa"),
                    "data": .object([
                        "toolName": .string("Bash"),
                        "input": .object([
                            "command": .string("swift build --package-path apps/mac && swift test")
                        ]),
                    ]),
                ])))
        #expect(
            row == .tool(
                id: "a1", title: "Bash",
                detail: "Bash: swift build --package-path apps/mac && swift test",
                itemType: "command_execution", phase: .succeeded, output: nil, outputIsError: false))
    }

    // MARK: Native tool identity

    @Test func toolIdentityNamesTheRowAndItsFamily() {
        let payload = JSONValue.object([
            "itemType": .string("mcp_tool_call"),
            "detail": .string("query=workers kv"),
            "data": .object([
                "tool": .object([
                    "family": .string("mcp"),
                    "toolName": .string("mcp__cloudflare__docs"),
                    "displayName": .string("Cloudflare · Docs"),
                ])
            ]),
        ])
        let row = ActivityRows.row(
            for: activity(kind: "tool.completed", summary: "MCP tool call", payload: payload))
        #expect(
            row == .tool(
                id: "a1", title: "Cloudflare · Docs", detail: "query=workers kv",
                itemType: "mcp_tool_call", phase: .succeeded, output: nil, outputIsError: false))
        #expect(ActivityRows.toolFamily(in: payload) == "mcp")
    }

    @Test func toolFamilyIsNilWithoutAnIdentity() {
        #expect(
            ActivityRows.toolFamily(
                in: .object(["data": .object(["toolName": .string("Bash")])])) == nil)
        #expect(ActivityRows.toolFamily(in: .null) == nil)
    }

    @Test func dataWithoutInputFallsBackToPayloadDetail() {
        let row = ActivityRows.row(
            for: activity(
                kind: "tool.completed", summary: "Bash",
                payload: .object([
                    "itemType": .string("command_execution"),
                    "detail": .string("swift build"),
                    "data": .object(["toolCallId": .string("call-9")]),
                ])))
        #expect(
            row == .tool(
                id: "tool:call-9", title: "Bash", detail: "swift build",
                itemType: "command_execution", phase: .succeeded, output: nil, outputIsError: false))
    }

    // MARK: Tool output extraction

    @Test func claudeStringResultContentIsExtracted() {
        let row = ActivityRows.row(
            for: activity(
                kind: "tool.completed", summary: "Bash",
                payload: .object([
                    "itemType": .string("command_execution"),
                    "data": .object([
                        "toolName": .string("Bash"),
                        "input": .object(["command": .string("echo hi")]),
                        "result": .object([
                            "type": .string("tool_result"),
                            "tool_use_id": .string("tu-1"),
                            "content": .string("hi\n"),
                        ]),
                    ]),
                ])))
        #expect(
            row == .tool(
                id: "a1", title: "Bash", detail: "Bash: echo hi",
                itemType: "command_execution", phase: .succeeded,
                output: "hi", outputIsError: false))
    }

    @Test func claudeArrayOfTextBlocksIsJoined() {
        let row = ActivityRows.row(
            for: activity(
                kind: "tool.completed", summary: "Bash",
                payload: .object([
                    "itemType": .string("command_execution"),
                    "data": .object([
                        "toolName": .string("Bash"),
                        "input": .object(["command": .string("ls")]),
                        "result": .object([
                            "type": .string("tool_result"),
                            "tool_use_id": .string("tu-2"),
                            "content": .array([
                                .object(["type": .string("text"), "text": .string("a.swift")]),
                                .object(["type": .string("text"), "text": .string("b.swift")]),
                            ]),
                        ]),
                    ]),
                ])))
        guard case .tool(_, _, _, _, _, let output, let isError) = row else {
            Issue.record("expected tool row")
            return
        }
        #expect(output == "a.swift\nb.swift")
        #expect(isError == false)
    }

    @Test func claudeIsErrorFlagIsPropagated() {
        let row = ActivityRows.row(
            for: activity(
                kind: "tool.completed", summary: "Bash",
                payload: .object([
                    "itemType": .string("command_execution"),
                    "status": .string("failed"),
                    "data": .object([
                        "toolName": .string("Bash"),
                        "input": .object(["command": .string("false")]),
                        "result": .object([
                            "type": .string("tool_result"),
                            "tool_use_id": .string("tu-3"),
                            "content": .string("command failed"),
                            "is_error": .bool(true),
                        ]),
                    ]),
                ])))
        guard case .tool(_, _, _, _, let phase, let output, let isError) = row else {
            Issue.record("expected tool row")
            return
        }
        #expect(phase == .failed)
        #expect(output == "command failed")
        #expect(isError == true)
    }

    @Test func codexAggregatedOutputOnItemIsExtracted() {
        // Codex mapItemLifecycle puts the raw V2 notification in data:
        // `{ item: { type: "commandExecution", aggregatedOutput, … } }`.
        let row = ActivityRows.row(
            for: activity(
                kind: "tool.completed", summary: "Ran command",
                payload: .object([
                    "itemType": .string("command_execution"),
                    "detail": .string("swift test"),
                    "data": .object([
                        "item": .object([
                            "type": .string("commandExecution"),
                            "command": .string("swift test"),
                            "aggregatedOutput": .string("Test Suite 'All tests' passed\n"),
                            "exitCode": .int(0),
                        ]),
                    ]),
                ])))
        guard case .tool(_, _, _, _, _, let output, let isError) = row else {
            Issue.record("expected tool row")
            return
        }
        #expect(output == "Test Suite 'All tests' passed")
        #expect(isError == false)
    }

    @Test func codexSnakeCaseAggregatedOutputIsAccepted() {
        let row = ActivityRows.row(
            for: activity(
                kind: "tool.completed", summary: "Ran command",
                payload: .object([
                    "itemType": .string("command_execution"),
                    "data": .object([
                        "aggregated_output": .string("ok"),
                    ]),
                ])))
        guard case .tool(_, _, _, _, _, let output, _) = row else {
            Issue.record("expected tool row")
            return
        }
        #expect(output == "ok")
    }

    @Test func missingOrGarbageDataYieldsNilOutput() {
        let noData = ActivityRows.row(
            for: activity(
                kind: "tool.completed", summary: "Bash",
                payload: .object([
                    "itemType": .string("command_execution"),
                    "detail": .string("echo hi"),
                ])))
        let garbage = ActivityRows.row(
            for: activity(
                kind: "tool.completed", summary: "Bash",
                payload: .object([
                    "itemType": .string("command_execution"),
                    "data": .object([
                        "result": .string("not-an-object"),
                        "item": .bool(true),
                    ]),
                ])))
        guard case .tool(_, _, _, _, _, let out1, let err1) = noData,
            case .tool(_, _, _, _, _, let out2, let err2) = garbage
        else {
            Issue.record("expected tool rows")
            return
        }
        #expect(out1 == nil)
        #expect(err1 == false)
        #expect(out2 == nil)
        #expect(err2 == false)
    }

    @Test func outputStripsTrailingExitCodeMarker() {
        let row = ActivityRows.row(
            for: activity(
                kind: "tool.completed", summary: "Bash",
                payload: .object([
                    "itemType": .string("command_execution"),
                    "data": .object([
                        "result": .object([
                            "content": .string("built successfully\n\n<exited with exit code 0>"),
                        ]),
                    ]),
                ])))
        guard case .tool(_, _, _, _, _, let output, _) = row else {
            Issue.record("expected tool row")
            return
        }
        #expect(output == "built successfully")
    }

    @Test func largeOutputIsCappedWithMarker() {
        let big = String(repeating: "x", count: ActivityRows.maxStoredOutputChars + 500)
        let row = ActivityRows.row(
            for: activity(
                kind: "tool.completed", summary: "Bash",
                payload: .object([
                    "itemType": .string("command_execution"),
                    "data": .object([
                        "result": .object([
                            "content": .string(big),
                        ]),
                    ]),
                ])))
        guard case .tool(_, _, _, _, _, let output, _) = row else {
            Issue.record("expected tool row")
            return
        }
        #expect(output != nil)
        #expect(output!.hasSuffix("\n… output truncated"))
        #expect(output!.count == ActivityRows.maxStoredOutputChars + "\n… output truncated".count)
    }

    @Test func emptyResultContentYieldsNilOutput() {
        let row = ActivityRows.row(
            for: activity(
                kind: "tool.completed", summary: "Bash",
                payload: .object([
                    "itemType": .string("command_execution"),
                    "data": .object([
                        "result": .object([
                            "content": .string("   \n  "),
                        ]),
                    ]),
                ])))
        guard case .tool(_, _, _, _, _, let output, _) = row else {
            Issue.record("expected tool row")
            return
        }
        #expect(output == nil)
    }

    // MARK: Tone fallbacks

    @Test func errorToneUsesSummaryAsTitleAndPayloadMessageAsDetail() {
        let row = ActivityRows.row(
            for: activity(
                tone: .error, kind: "turn.error", summary: "Turn failed",
                payload: .object(["message": .string("provider crashed")])))
        #expect(
            row == .tool(
                id: "a1", title: "Turn failed", detail: "provider crashed", itemType: nil,
                phase: .failed, output: nil, outputIsError: false))
    }

    @Test func infoToneBecomesNotice() {
        let row = ActivityRows.row(
            for: activity(tone: .info, kind: "system-message", summary: "Session resumed"))
        #expect(row == .notice(id: "a1", text: "Session resumed"))
    }
}
