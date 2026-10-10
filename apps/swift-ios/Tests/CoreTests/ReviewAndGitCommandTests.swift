import Foundation
import Testing
@testable import T3Code

@Suite("Review diff queries and workspace metadata")
struct ReviewAndGitCommandTests {
    @Test func turnAndFullThreadQueriesKeepWireIdentityAndRanges() throws {
        let turn = try ReviewCheckpointDiffQuery(threadID: "wire-thread", fromTurnCount: 6, toTurnCount: 7)
        #expect(turn.method == "orchestration.getTurnDiff")
        #expect(turn.payload["threadId"] == .string("wire-thread"))
        #expect(turn.payload["fromTurnCount"] == .number(6))
        #expect(turn.payload["ignoreWhitespace"] == .bool(false))
        try turn.validate(.init(threadId: "wire-thread", fromTurnCount: 6, toTurnCount: 7, diff: "patch"))
        #expect(throws: RPCError.self) {
            try turn.validate(.init(threadId: "other-thread", fromTurnCount: 6, toTurnCount: 7, diff: "patch"))
        }
        #expect(throws: RPCError.self) {
            try turn.validate(.init(threadId: "wire-thread", fromTurnCount: 5, toTurnCount: 7, diff: "patch"))
        }
        let full = try ReviewCheckpointDiffQuery(threadID: "wire-thread", fromTurnCount: nil, toTurnCount: 7)
        #expect(full.method == "orchestration.getFullThreadDiff")
        #expect(full.payload["fromTurnCount"] == nil)
        try full.validate(.init(threadId: "wire-thread", fromTurnCount: 0, toTurnCount: 7, diff: "patch"))
    }

    @Test func invalidCheckpointRangeFailsBeforeARequest() {
        #expect(throws: RPCError.self) { try ReviewCheckpointDiffQuery(threadID: "thread", fromTurnCount: 3, toTurnCount: 2) }
        #expect(throws: RPCError.self) { try ReviewCheckpointDiffQuery(threadID: "thread", fromTurnCount: -1, toTurnCount: 2) }
    }

    @Test func workspaceMetadataPreservesNullAndV1V2Dispatch() throws {
        let command = SourceControlWorkspaceCommand.make(threadID: "wire-thread", branch: "feature/fix", worktreePath: "/repo/worktree", commandID: "command")
        #expect(command["type"] == .string("thread.meta.update"))
        #expect(command["threadId"] == .string("wire-thread"))
        let v2 = try #require(OrchestrationV2Commands.plan(command).requests.first)
        #expect(v2.payload["type"] == .string("thread.metadata.update"))
        #expect(v2.payload["branch"] == .string("feature/fix"))
        #expect(v2.payload["worktreePath"] == .string("/repo/worktree"))
        #expect(v2.payload["threadId"] == .string("wire-thread"))
        let root = SourceControlWorkspaceCommand.make(threadID: "wire-thread", branch: nil, worktreePath: nil, commandID: "root-command")
        let rootV2 = try #require(OrchestrationV2Commands.plan(root).requests.first)
        #expect(root["branch"] == .null)
        #expect(root["worktreePath"] == .null)
        #expect(rootV2.payload["branch"] == .null)
        #expect(rootV2.payload["worktreePath"] == .null)
    }
}
