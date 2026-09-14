import Foundation
import Testing
@testable import T3Code

@Suite("Conversation rewind")
struct NativeConversationRewindTests {
    @Test
    func keepFilesUsesACommandOlderServersCannotTreatAsFileRestore() {
        let command = OrchestrationCommands.revertConversation(
            threadID: "thread", turnCount: 4, commandID: "command", createdAt: "2026-09-13T00:00:00Z"
        )
        #expect(command == .object([
            "type": .string("thread.conversation.revert"),
            "threadId": .string("thread"), "turnCount": .number(4),
            "commandId": .string("command"), "createdAt": .string("2026-09-13T00:00:00Z"),
        ]))
    }

    @Test
    func paginatedAndSteeredMessagesUseCheckpointBoundaries() {
        let thread = thread(messages: [
            message("user", role: "user"), message("steering", role: "user"),
            message("assistant", role: "assistant"),
        ], checkpoints: [.init(
            turnId: "turn", checkpointTurnCount: 8, checkpointRef: "ref",
            status: "ready", files: [], assistantMessageId: "assistant", completedAt: "2026-09-13T00:00:00Z"
        )])
        #expect(NativeConversationRewind.turnCount(before: "steering", in: thread) == 7)
        #expect(NativeConversationRewind.turnCount(before: "user", in: thread) == nil)
        #expect(NativeConversationRewind.turnCount(before: "assistant", in: thread) == nil)
        #expect(NativeConversationRewind.turnCount(before: "missing", in: thread) == nil)
    }

    @Test
    func draftRecoveryKeepsExistingInputAndSameNameAttachments() {
        let existing = FeatureDraftAttachment(data: Data([1]), filename: "same.txt", mimeType: "text/plain")
        let recovered = FeatureDraftAttachment(data: Data([2]), filename: "same.txt", mimeType: "text/plain")
        let draft = FeatureComposerDraft(
            text: "Current draft", attachments: [existing],
            selection: .init(providerID: "selected-provider", modelID: "selected-model"),
            workspace: .init(mode: .worktree, branch: "feature", worktreePath: "/worktree", startFromOrigin: true)
        )
        let result = FeatureConversationRewind.recover(.init(
            message: .init(id: "message", role: .user, text: "Original prompt"), attachments: [recovered]
        ), draft: draft)
        #expect(result.text == "Current draft\n\nOriginal prompt")
        #expect(result.attachments.map(\.id) == [existing.id, recovered.id])
        #expect(result.attachments.map(\.data) == [Data([1]), Data([2])])
        #expect(result.selection == draft.selection)
        #expect(result.workspace == draft.workspace)
    }

    @Test
    func busyThreadsCannotRewind() {
        for state in [FeatureThreadState.working, .queued, .monitoring, .waitingForApproval, .waitingForInput] {
            let detail = FeatureThreadDetail(thread: .init(id: "thread", projectID: "project", title: "Task", state: state))
            #expect(!FeatureConversationRewind.canStart(in: detail))
        }
    }

    @Test
    func attachmentOnlyRewindDoesNotRestoreGeneratedBootstrapText() {
        let result = FeatureConversationRewind.recover(.init(
            message: .init(id: "user", role: .user, text: "[User attached one or more files without additional text. Respond using the conversation context and the attached files.]"),
            attachments: [.init(data: Data([1]), filename: "input.txt", mimeType: "text/plain")]
        ), draft: .init(text: "Existing draft"))
        #expect(result.text == "Existing draft")
        #expect(result.attachments.count == 1)
    }

    @Test
    func literalBootstrapSentenceWithoutAttachmentsIsPreserved() {
        let message = FeatureMessage(id: "user", role: .user, text: "[User attached one or more files without additional text. Respond using the conversation context and the attached files.]")
        let result = FeatureConversationRewind.recover(.init(message: message, attachments: []), draft: .init())
        #expect(result.text == message.text)
    }

    @Test
    func missingRecoveryFilesAreNotSilentlyConsumed() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FeatureComposerDraftStore(
            fileURL: directory.appendingPathComponent("drafts.json"),
            attachmentStorageRootURL: directory.appendingPathComponent("owned")
        )
        let recoveryKey = FeatureComposerDraftStore.rewindRecoveryKey(for: "thread")
        try await store.setDraft(.init(attachments: [.init(
            ownedFile: .init(fileName: "missing.txt", url: directory.appendingPathComponent("missing.txt"), byteCount: 3),
            filename: "input.txt", mimeType: "text/plain"
        )]), for: recoveryKey)
        do {
            _ = try await store.consumeRewindRecovery(for: "thread")
            Issue.record("Missing files must keep their recovery record")
        } catch {
            #expect(error.localizedDescription.contains("recovery copy is kept"))
        }
        #expect(try await store.hasRewindRecovery(for: "thread"))
        #expect(try await store.draft(for: "thread") == nil)
    }

    @Test
    func recoveryKeysDoNotOverwriteAnotherThreadsDraft() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FeatureComposerDraftStore(fileURL: directory.appendingPathComponent("drafts.json"))
        let key = "environment:one:thread:foo"
        let otherKey = key + ":rewind-recovery"
        try await store.setDraft(.init(text: "Other thread's draft"), for: otherKey)
        try await store.setDraft(.init(text: "Recovered prompt"), for: FeatureComposerDraftStore.rewindRecoveryKey(for: key))
        let recovered = try await store.consumeRewindRecovery(for: key)
        #expect(recovered?.text == "Recovered prompt")
        #expect(try await store.draft(for: otherKey)?.text == "Other thread's draft")
    }

    @Test
    func completionIgnoresOldAndUnrelatedEvents() async throws {
        let stream = AsyncThrowingStream<[ThreadStreamItem], Error>.makeStream()
        stream.continuation.yield([
            .event(event("thread.reverted", sequence: 10, threadID: "thread", turnCount: 0)),
            .event(event("thread.reverted", sequence: 11, threadID: "other", turnCount: 0)),
            .event(event("thread.reverted", sequence: 12, threadID: "thread", turnCount: 2)),
        ])
        stream.continuation.finish()
        do {
            try await wait(stream.stream)
            Issue.record("Unrelated events must not complete this rewind")
        } catch {
            #expect(error.localizedDescription.contains("connection closed"))
        }
    }

    @Test
    func completionAcceptsTheRevertedEvent() async throws {
        let stream = AsyncThrowingStream<[ThreadStreamItem], Error>.makeStream()
        stream.continuation.yield([.event(event("thread.reverted", sequence: 11, threadID: "thread", turnCount: 0))])
        try await wait(stream.stream)
    }

    @Test
    func providerFailureDoesNotBecomeSuccessfulRecovery() async throws {
        let stream = AsyncThrowingStream<[ThreadStreamItem], Error>.makeStream()
        stream.continuation.yield([.event(.object([
            "type": .string("thread.activity-appended"), "sequence": .number(11),
            "payload": .object([
                "threadId": .string("thread"),
                "activity": .object([
                    "kind": .string("checkpoint.revert.failed"),
                    "payload": .object(["detail": .string("History boundary is unavailable"), "turnCount": .number(0)]),
                ]),
            ]),
        ]))])
        do {
            try await wait(stream.stream)
            Issue.record("Provider failure must reject the rewind")
        } catch {
            #expect(error.localizedDescription == "History boundary is unavailable")
        }
    }

    @Test
    func replacementSnapshotConfirmsHistoryWasRemoved() async throws {
        let stream = AsyncThrowingStream<[ThreadStreamItem], Error>.makeStream()
        stream.continuation.yield([.snapshot(.init(snapshotSequence: 11, thread: thread(), page: nil))])
        try await wait(stream.stream)
    }

    private func wait(_ events: AsyncThrowingStream<[ThreadStreamItem], Error>) async throws {
        _ = try await NativeConversationRewind.waitForCompletion(
            batches: events, threadID: "thread", messageID: "user", turnCount: 0,
            afterSequence: 10, previousFailureIDs: []
        )
    }

    private func event(_ type: String, sequence: Int, threadID: String, turnCount: Int) -> JSONValue {
        .object([
            "type": .string(type), "sequence": .number(Double(sequence)),
            "payload": .object(["threadId": .string(threadID), "turnCount": .number(Double(turnCount))]),
        ])
    }

    private func message(_ id: String, role: String) -> OrchestrationMessage {
        .init(id: id, role: role, text: id, attachments: [], turnId: "turn", streaming: false,
              createdAt: "2026-09-13T00:00:00Z", updatedAt: "2026-09-13T00:00:00Z")
    }

    private func thread(messages: [OrchestrationMessage] = [], checkpoints: [CheckpointSummary] = []) -> OrchestrationThread {
        .init(
            id: "thread", projectId: "project", title: "Task",
            modelSelection: .init(instanceId: "codex", model: "test-model"),
            runtimeMode: .fullAccess, interactionMode: .default, branch: nil, worktreePath: nil,
            latestTurn: nil, createdAt: "2026-09-13T00:00:00Z", updatedAt: "2026-09-13T00:00:00Z",
            archivedAt: nil, settledOverride: nil, settledAt: nil, snoozedUntil: nil,
            snoozedAt: nil, pinnedAt: nil, deletedAt: nil, messages: messages, activities: [],
            checkpoints: checkpoints, session: nil
        )
    }
}
