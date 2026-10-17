import Foundation
import Testing
@testable import T3Code

@Suite("Live command output and individual agent stop")
@MainActor
struct FeatureLiveToolsTests {
    @Test func missingCapabilitySelectsFinalOutputFallback() async throws {
        let client = CommandOutputClientStub(stream: nil)
        let state = FeatureCommandOutputState()
        #expect(await state.observe(client: client, threadID: "scoped-fork", source: try source) == false)
        #expect(state.phase == .unsupported)
        #expect(state.output == nil)
    }

    @Test func streamReplacesAfterReconnectAndKeepsFinalTailForCopy() async throws {
        let stream = AsyncThrowingStream<CommandOutputFrame, Error> { continuation in
            continuation.yield(.init(kind: .replace, text: "old\n", truncated: false, running: true))
            continuation.yield(.init(kind: .append, text: "stale\n", truncated: false, running: true))
            continuation.yield(.init(kind: .replace, text: "new\n", truncated: true, running: true))
            continuation.yield(.init(kind: .append, text: "done\n", truncated: false, running: false))
            continuation.finish()
        }
        let client = CommandOutputClientStub(stream: stream)
        let state = FeatureCommandOutputState()
        #expect(await state.observe(client: client, threadID: "scoped-fork", source: try source))
        #expect(client.request?.0 == "scoped-fork")
        #expect(client.request?.1.sourceThreadID == "source")
        #expect(state.output?.text == "new\ndone\n")
        #expect(state.output?.truncated == true)
        #expect(state.output?.running == false)
        let formatted = FeatureV2FormattedItem(raw: .object([
            "type": .string("command_execution"), "input": .string("run"), "output": .string("old persisted output"),
        ]))
        #expect(FeatureV2ItemDetail.copyText(formatted: formatted, commandOutput: state.output?.text) == "run\n\nnew\ndone\n")
        state.reset()
        #expect(state.output == nil)
    }

    @Test func failurePreservesTailAndNeverBecomesAnEmptySuccessfulResult() async throws {
        let stream = AsyncThrowingStream<CommandOutputFrame, Error> { continuation in
            continuation.yield(.init(kind: .replace, text: "partial", truncated: false, running: true))
            continuation.finish(throwing: RPCError.disconnected)
        }
        let state = FeatureCommandOutputState()
        #expect(await state.observe(client: CommandOutputClientStub(stream: stream), threadID: "thread", source: try source))
        #expect(state.output?.text == "partial")
        guard case .failed = state.phase else { Issue.record("Stream failure was hidden"); return }
    }

    @Test func cancellationTerminatesTheSubscriptionAndResetDropsItsTail() async throws {
        let (stream, continuation) = AsyncThrowingStream<CommandOutputFrame, Error>.makeStream()
        let (opened, openedContinuation) = AsyncStream<Void>.makeStream()
        let (terminated, terminatedContinuation) = AsyncStream<Void>.makeStream()
        continuation.onTermination = { _ in terminatedContinuation.yield(()); terminatedContinuation.finish() }
        let client = CommandOutputClientStub(stream: stream)
        client.onOpen = { openedContinuation.yield(()); openedContinuation.finish() }
        let state = FeatureCommandOutputState()
        let metadata = try source
        let task = Task { await state.observe(client: client, threadID: "thread", source: metadata) }
        for await _ in opened { break }
        task.cancel()
        _ = await task.value
        for await _ in terminated { break }
        state.reset()
        #expect(state.output == nil)
        #expect(state.phase == .loading)
    }

    @Test func prematureEndAndAppendWithoutReplacementAreErrors() async throws {
        for frame in [CommandOutputFrame?.none, .some(.init(kind: .append, text: "orphan", truncated: false, running: true))] {
            let stream = AsyncThrowingStream<CommandOutputFrame, Error> { continuation in
                if let frame { continuation.yield(frame) }
                continuation.finish()
            }
            let state = FeatureCommandOutputState()
            _ = await state.observe(client: CommandOutputClientStub(stream: stream), threadID: "thread", source: try source)
            guard case .failed = state.phase else { Issue.record("Incomplete output was accepted"); continue }
        }
    }

    @Test func stopUsesTheSelectedAgentsOwningRunInsteadOfTheCurrentParentRun() throws {
        let projection = control(agents: [agent("older-agent", run: "older-run"), agent("newer-agent", run: "current-run")])
        let command = try FeatureSubagentStopPolicy.command(projection: projection, threadID: "thread", subagentID: "older-agent", commandID: "command")
        #expect(command == .object([
            "type": .string("subagent.stop"), "commandId": .string("command"), "threadId": .string("thread"),
            "runId": .string("older-run"), "subagentId": .string("older-agent"),
        ]))
    }

    @Test func onlyActiveClaudeNativeTasksWithStrongEvidenceCanStop() throws {
        let invalid: [[String: JSONValue]] = [
            ["origin": .string("app_owned")], ["driver": .string("codex")], ["runId": .null],
            ["status": .string("completed")], ["status": .string("idle")], ["threadId": .string("other")],
            ["nativeTaskRef": .null],
            ["nativeTaskRef": .object(["strength": .string("weak"), "nativeId": .string("task")])],
            ["nativeTaskRef": .object(["strength": .string("strong"), "nativeId": .null])],
        ]
        for patch in invalid {
            let projection = control(agents: [V2Fixture.patch(agent("agent"), patch)])
            #expect(try FeatureSubagentStopPolicy.targets(projection: projection, threadID: "thread").isEmpty)
            #expect(throws: FeatureCapabilityUnavailable.self) {
                try FeatureSubagentStopPolicy.command(projection: projection, threadID: "thread", subagentID: "agent")
            }
        }
        for status in ["pending", "running", "waiting"] {
            #expect(try FeatureSubagentStopPolicy.targets(projection: control(agents: [
                V2Fixture.patch(agent("agent"), ["status": .string(status)]),
            ]), threadID: "thread")["agent"] == "owning-run")
        }
    }

    @Test func changedOrWrongThreadControlsCannotTargetAnotherAgent() throws {
        #expect(throws: OrchestrationV2StateError.self) {
            try FeatureSubagentStopPolicy.targets(projection: control(agents: [agent("agent")]), threadID: "other-thread")
        }
        #expect(throws: FeatureCapabilityUnavailable.self) {
            try FeatureSubagentStopPolicy.command(projection: control(agents: []), threadID: "thread", subagentID: "agent")
        }
    }

    private var source: OrchestrationV2TimelineMetadata {
        get throws {
            let raw = V2Fixture.item("command", type: "command_execution", ordinal: 1, fields: [
                "threadId": .string("source"), "input": .string("run"),
            ])
            return try OrchestrationV2TimelineMetadata(V2Fixture.row(raw, visibility: "inherited").decode(OrchestrationV2ProjectedTurnItem.self))
        }
    }

    private func control(agents: [JSONValue]) -> JSONValue {
        .object(["thread": .object(["id": .string("thread")]), "subagents": .array(agents)])
    }

    private func agent(_ id: String, run: String = "owning-run") -> JSONValue {
        .object([
            "id": .string(id), "threadId": .string("thread"), "runId": .string(run),
            "origin": .string("provider_native"), "driver": .string("claudeAgent"), "status": .string("running"),
            "nativeTaskRef": .object(["strength": .string("strong"), "nativeId": .string("native-task")]),
        ])
    }
}

@MainActor
private final class CommandOutputClientStub: FeatureCommandOutputStreaming {
    let stream: AsyncThrowingStream<CommandOutputFrame, Error>?
    var request: (String, OrchestrationV2TimelineMetadata)?
    var onOpen: (() -> Void)?
    init(stream: AsyncThrowingStream<CommandOutputFrame, Error>?) { self.stream = stream }
    func commandOutput(threadID: String, source: OrchestrationV2TimelineMetadata) async throws -> AsyncThrowingStream<CommandOutputFrame, Error>? {
        request = (threadID, source)
        onOpen?()
        return stream
    }
}
