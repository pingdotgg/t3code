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
    func draftRecoveryKeepsExistingInputAndSameNameAttachments() throws {
        let existing = FeatureDraftAttachment(data: Data([1]), filename: "same.txt", mimeType: "text/plain")
        let recovered = FeatureDraftAttachment(data: Data([2]), filename: "same.txt", mimeType: "text/plain")
        let draft = FeatureComposerDraft(
            text: "Current draft", attachments: [existing],
            selection: .init(providerID: "selected-provider", modelID: "selected-model"),
            workspace: .init(mode: .worktree, branch: "feature", worktreePath: "/worktree", startFromOrigin: true)
        )
        let result = try FeatureConversationRewind.recover(.init(
            message: .init(id: "message", role: .user, text: "Original prompt"), attachments: [recovered]
        ), draft: draft)
        #expect(result.text == "Current draft\n\nOriginal prompt")
        #expect(result.attachments.map(\.id) == [existing.id, recovered.id])
        #expect(result.attachments.map(\.data) == [Data([1]), Data([2])])
        #expect(result.selection == draft.selection)
        #expect(result.workspace == draft.workspace)
    }

    @Test
    func recoveredContextKeepsItsLinksAndUsesNewAttachmentIDsOnResend() throws {
        let existing = ComposerContextRecord(contextId: "existing", label: "Sources", payload: .mention(.init(path: "src")))
        let shared = ComposerContextRecord(contextId: "shared", label: "Build", payload: .skill(.init(name: "build")))
        let file = ComposerContextRecord(contextId: "file", label: "Pasted text", payload: .file(.init(
            attachmentId: "old-server-file", name: "paste.txt", mimeType: "text/plain", sizeBytes: 3
        )))
        let terminal = FeatureComposerContext.terminalRecord(text: "Original output", terminalID: "terminal", label: "Terminal")
        let future = ComposerContextRecord(contextId: "future", label: "Captured input", payload: .unknown(
            kind: "future", payload: .object(["value": .string("Keep this")])
        ))
        let restoredRecords = [shared, file, terminal, future]
        let prompt = restoredRecords.map(ComposerContextReferences.format).joined(separator: " ")
        let copied = FeatureDraftAttachment(data: Data([1, 2, 3]), filename: "paste.txt", mimeType: "text/plain", source: .pastedText)
        let result = try FeatureConversationRewind.recover(.init(
            message: .init(id: "user", role: .user, text: prompt, attachments: [.init(
                id: "old-server-file", name: "paste.txt", mimeType: "text/plain", sizeBytes: 3, source: .pastedText
            )], context: .init(records: restoredRecords)),
            attachments: [copied]
        ), draft: .init(text: ComposerContextReferences.format(existing), context: .init(records: [existing, shared])))

        #expect(result.text.hasSuffix(prompt))
        #expect(result.context?.records.map(\.contextId) == ["existing", "shared", "file", terminal.contextId, "future"])
        #expect(result.context?.records.first(where: { $0.contextId == "file" })?.attachment?.attachmentId == copied.id.uuidString)
        #expect(result.context?.records.last == future)
        #expect(result.attachments.first?.source == .pastedText)

        let upload = try UploadChatAttachment(
            id: copied.id, data: copied.data, name: copied.filename, mimeType: copied.mimeType, contextSource: copied.source
        )
        let resent = T3Client.prepareMessageContext(
            text: result.text + " Edit this", context: result.context, attachments: [upload],
            uploadedAttachments: [.object(["id": .string("new-server-file")])], supportsContext: true
        )
        #expect(resent.context?.records.count == result.context?.records.count)
        #expect(resent.context?.records.first(where: { $0.contextId == "file" })?.attachment?.attachmentId == "new-server-file")
        #expect(resent.text == result.text + " Edit this")
        #expect(upload.contextSource == .pastedText)
    }

    @Test
    func busyThreadsCannotRewind() {
        for state in [FeatureThreadState.working, .queued, .monitoring, .waitingForApproval, .waitingForInput] {
            let detail = FeatureThreadDetail(thread: .init(id: "thread", projectID: "project", title: "Task", state: state))
            #expect(!FeatureConversationRewind.canStart(in: detail))
        }
    }

    @Test
    func attachmentOnlyRewindDoesNotRestoreGeneratedBootstrapText() throws {
        let result = try FeatureConversationRewind.recover(.init(
            message: .init(id: "user", role: .user, text: "[User attached one or more files without additional text. Respond using the conversation context and the attached files.]"),
            attachments: [.init(data: Data([1]), filename: "input.txt", mimeType: "text/plain")]
        ), draft: .init(text: "Existing draft"))
        #expect(result.text == "Existing draft")
        #expect(result.attachments.count == 1)
    }

    @Test
    func literalBootstrapSentenceWithoutAttachmentsIsPreserved() throws {
        let message = FeatureMessage(id: "user", role: .user, text: "[User attached one or more files without additional text. Respond using the conversation context and the attached files.]")
        let result = try FeatureConversationRewind.recover(.init(message: message, attachments: []), draft: .init())
        #expect(result.text == message.text)
    }

    @Test(arguments: [0, 2, 3])
    func recoveryRequiresReadableFilesWithTheSavedSize(actualBytes: Int) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let attachmentRoot = directory.appendingPathComponent("owned")
        let fileName = UUID().uuidString + ".txt"
        let fileURL = attachmentRoot.appendingPathComponent(fileName)
        if actualBytes > 0 {
            try FileManager.default.createDirectory(at: attachmentRoot, withIntermediateDirectories: true)
            try Data(repeating: 1, count: actualBytes).write(to: fileURL)
        }
        let store = FeatureComposerDraftStore(
            fileURL: directory.appendingPathComponent("drafts.json"),
            attachmentStorageRootURL: attachmentRoot
        )
        let recoveryKey = FeatureComposerDraftStore.rewindRecoveryKey(for: "thread")
        try await store.setDraft(.init(attachments: [.init(
            ownedFile: .init(fileName: fileName, url: fileURL, byteCount: 3),
            filename: "input.txt", mimeType: "text/plain"
        )]), for: recoveryKey)
        do {
            let recovered = try await store.consumeRewindRecovery(for: "thread")
            #expect(actualBytes == 3)
            #expect(recovered?.attachments.first?.ownedFile?.url == fileURL)
        } catch {
            #expect(actualBytes != 3)
            #expect(error.localizedDescription.contains("recovery copy is kept"))
        }
        #expect(try await store.hasRewindRecovery(for: "thread") == (actualBytes != 3))
        #expect(try await (store.draft(for: "thread") == nil) == (actualBytes != 3))
    }

    @Test
    func rewindRecoveryUsesTheComposerAttachmentLimit() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FeatureComposerDraftStore(fileURL: directory.appendingPathComponent("drafts.json"))
        let files = (0..<9).map { FeatureDraftAttachment(data: Data([1]), filename: "file-\($0).txt", mimeType: "text/plain") }
        try await store.setDraft(.init(attachments: files), for: FeatureComposerDraftStore.rewindRecoveryKey(for: "thread"))
        let recovered = try await store.consumeRewindRecovery(for: "thread")
        #expect(recovered?.attachments.map(\.id) == files.map(\.id))
        #expect(try await store.hasRewindRecovery(for: "thread") == false)
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

    @Test
    func v2ProjectionReportsFailureForTheRequestedRollback() async throws {
        var failed = thread(messages: [message("user", role: "user")])
        failed.orchestrationV2Control = .object(["thread": .object([
            "rollbackFailure": .object(["requestId": .string("rollback"), "message": .string("Provider history is unavailable")]),
        ])])
        let stream = AsyncThrowingStream<[ThreadStreamItem], Error>.makeStream()
        stream.continuation.yield([.projection(.init(snapshotSequence: 11, thread: failed))])
        stream.continuation.finish()
        do {
            _ = try await NativeConversationRewind.waitForCompletion(
                batches: stream.stream, threadID: "thread", messageID: "user", turnCount: 0,
                afterSequence: 10, previousFailureIDs: [], rollbackRequestID: "rollback"
            )
            Issue.record("The requested rollback failure must reach the user")
        } catch {
            #expect(error.localizedDescription == "Provider history is unavailable")
        }
    }

    @Test
    func v2ProjectionConfirmsRollbackWithoutLegacyEvents() async throws {
        let stream = AsyncThrowingStream<[ThreadStreamItem], Error>.makeStream()
        stream.continuation.yield([.projection(.init(snapshotSequence: 11, thread: thread()))])
        stream.continuation.finish()
        try await wait(stream.stream)
    }

    @Test
    func olderV2MessagesValidateWithAFullReadWithoutReplacingPagedState() async throws {
        let transport = try RewindHTTPTransport()
        let environment = Environment(id: "rewind", label: "Rewind", httpBaseURL: URL(string: "https://rewind.example")!,
                                      webSocketBaseURL: URL(string: "wss://rewind.example")!)
        let client = T3Client(environment: environment,
            credentialStore: InMemoryCredentialStore(credentials: [environment.id: .init(accessToken: "fixture-token")]),
            httpTransport: transport)
        let bounded = try await client.threadSnapshot(id: "thread-v2")
        let cursor = try #require(bounded.page?.beforeCursor)
        let selectedID = "message-v2-history-user"
        #expect(!bounded.thread.messages.contains { $0.id == selectedID })
        #expect(bounded.thread.checkpoints.isEmpty)

        let full = try await client.fullThreadSnapshot(id: "thread-v2")
        #expect(full.thread.messages.contains { $0.id == selectedID })
        #expect(full.page?.hasMore == false)
        #expect(full.snapshotSequence > bounded.snapshotSequence)
        let loaded = try await client.threadSnapshot(id: "thread-v2", beforeCursor: cursor)
        // The validation read must not replace the display cursor or its sequence.
        #expect(loaded.snapshotSequence == bounded.snapshotSequence)
        #expect(loaded.thread.messages.contains { $0.id == selectedID })
        #expect(loaded.thread.checkpoints.isEmpty)
        #expect(NativeConversationRewind.canRewind(before: selectedID, in: loaded.thread))
        let target = try NativeConversationRewind.target(before: selectedID, in: full.thread)
        #expect(target.runID == "run-v2-history")
        let command = target.command(threadID: "thread-v2")
        #expect(command["checkpointId"] == .string("genesis"))
        #expect(command["scopeId"] == .string("scope-v2"))
        #expect(command["restoreFiles"] == .bool(false))
        #expect(command["turnCount"] == nil)
        let paths = await transport.paths
        #expect(paths.filter { $0.contains("/api/orchestration/threads/") } == [
            "/api/orchestration/threads/thread-v2/bounded", "/api/orchestration/threads/thread-v2",
            "/api/orchestration/threads/thread-v2/history",
        ])
    }

    @Test
    func v2InheritedAndReadOnlyMessagesCannotRewind() {
        var local = thread(messages: [message("user", role: "user")])
        local.orchestrationV2Control = .object(["thread": .object([:]), "runs": .array([])])
        #expect(NativeConversationRewind.canRewind(before: "user", in: local))
        var inherited = local
        inherited.messages = [message("v2-inherited:source:user", role: "user")]
        #expect(!NativeConversationRewind.canRewind(before: "v2-inherited:source:user", in: inherited))
        local.orchestrationV2Control = .object(["thread": .object([
            "creationSource": .string("provider"),
            "lineage": .object(["relationshipToParent": .string("subagent")]),
        ])])
        #expect(!NativeConversationRewind.canRewind(before: "user", in: local))
    }

    @Test
    func v2CompletionNeedsTheSelectedRunRolledBackAfterAcceptance() async throws {
        var accepted = thread(messages: [message("user", role: "user")])
        accepted.orchestrationV2Control = .object([
            "runs": .array([.object(["id": .string("turn"), "status": .string("completed")])]),
        ])
        var missingMessage = accepted
        missingMessage.messages = []
        var completed = missingMessage
        completed.orchestrationV2Control = .object([
            "runs": .array([.object(["id": .string("turn"), "status": .string("rolled_back")])]),
        ])
        #expect(!NativeConversationRewind.isComplete(missingMessage, messageID: "user", turnCount: 0, rollbackRunID: "turn"))
        let stream = AsyncThrowingStream<[ThreadStreamItem], Error>.makeStream()
        stream.continuation.yield([
            .projection(.init(snapshotSequence: 10, thread: completed)),
            .projection(.init(snapshotSequence: 11, thread: accepted)),
            .projection(.init(snapshotSequence: 12, thread: missingMessage)),
            .projection(.init(snapshotSequence: 13, thread: completed)),
        ])
        stream.continuation.finish()
        let sequence = try await NativeConversationRewind.waitForCompletion(
            batches: stream.stream, threadID: "thread", messageID: "user", turnCount: 0,
            afterSequence: 10, previousFailureIDs: [], rollbackRequestID: "rollback", rollbackRunID: "turn"
        )
        #expect(sequence == 13)
    }

    @Test
    func v2FailureMatchesRequestIDWithoutAnInventedTurnCount() async throws {
        let stream = AsyncThrowingStream<[ThreadStreamItem], Error>.makeStream()
        for (sequence, requestID) in [(11, "other"), (12, "rollback")] {
            stream.continuation.yield([.event(.object([
                "type": .string("thread.activity-appended"), "sequence": .number(Double(sequence)),
                "payload": .object([
                    "threadId": .string("thread"), "activity": .object([
                        "kind": .string("checkpoint.revert.failed"),
                        "payload": .object(["requestId": .string(requestID), "detail": .string("Failure for \(requestID)")]),
                    ]),
                ]),
            ]))])
        }
        stream.continuation.finish()
        do {
            _ = try await NativeConversationRewind.waitForCompletion(
                batches: stream.stream, threadID: "thread", messageID: "user", turnCount: 0,
                afterSequence: 10, previousFailureIDs: [], rollbackRequestID: "rollback", rollbackRunID: "turn"
            )
            Issue.record("The matching failure must reject this rewind")
        } catch {
            #expect(error.localizedDescription == "Failure for rollback")
            #expect((error as? FeatureConversationRewindError)?.didNotRevert == true)
        }
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

private actor RewindHTTPTransport: HTTPTransport {
    private let bounded: JSONValue
    private let full: JSONValue
    private let history: JSONValue
    private(set) var paths: [String] = []

    init() throws {
        let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Fixtures/Wire")
        func fixture(_ name: String) throws -> JSONValue {
            try JSONDecoder.t3.decode(JSONValue.self, from: Data(contentsOf: directory.appendingPathComponent(name + ".json")))
        }
        func stopped(_ snapshot: JSONValue) -> [String: JSONValue] {
            var result = snapshot.v2Object
            var projection = result["projection"]!.v2Object
            projection["runs"] = .array((projection["runs"]?.v2Array ?? []).map { run in
                var fields = run.v2Object
                fields["status"] = .string(run["id"]?.stringValue == "run-v2-queued" ? "cancelled" : "completed")
                return .object(fields)
            })
            projection["providerThreads"] = .array((projection["providerThreads"]?.v2Array ?? []).map { provider in
                .object(provider.v2Object.merging(["pendingBackgroundTasks": .array([])]) { _, new in new })
            })
            projection["turnItems"] = .array((projection["turnItems"]?.v2Array ?? []).map { item in
                .object(item.v2Object.merging(["status": .string("completed")]) { _, new in new })
            })
            result["projection"] = .object(projection)
            return result
        }
        var bounded = stopped(try fixture("v2-thread-bounded-snapshot"))
        var boundedProjection = bounded["projection"]!.v2Object
        // Match the real SQL bounded read: older controls are absent, even after paging.
        boundedProjection["runs"] = .array((boundedProjection["runs"]?.v2Array ?? []).filter { $0["id"] != .string("run-v2-history") })
        boundedProjection["checkpoints"] = .array([])
        boundedProjection["checkpointScopes"] = .array([])
        bounded["projection"] = .object(boundedProjection)
        self.bounded = .object(bounded)
        var full = stopped(try fixture("v2-thread-with-history-snapshot"))
        var fullProjection = full["projection"]!.v2Object
        var genesis = fullProjection["checkpoints"]!.v2Array!.first!.v2Object
        genesis["id"] = .string("genesis")
        genesis["runId"] = .null
        genesis["appRunOrdinal"] = .null
        fullProjection["checkpoints"] = .array([.object(genesis)] + fullProjection["checkpoints"]!.v2Array!)
        full["projection"] = .object(fullProjection)
        full["snapshotSequence"] = .number(102)
        full["historyCursor"] = .null
        full["hasMoreHistory"] = .bool(false)
        self.full = .object(full)
        history = try fixture("v2-thread-older-history")
    }

    func data(for request: URLRequest) throws -> (Data, HTTPURLResponse) {
        let url = try #require(request.url)
        paths.append(url.path)
        let response: JSONValue
        switch url.path {
        case "/.well-known/t3/environment":
            response = .object([
                "environmentId": .string("rewind"), "label": .string("Rewind"),
                "platform": .object(["os": .string("darwin"), "arch": .string("arm64")]),
                "serverVersion": .string("fixture"), "capabilities": .object([:]), "orchestrationProtocolVersion": .number(2),
            ])
        case "/api/orchestration/threads/thread-v2/bounded": response = bounded
        case "/api/orchestration/threads/thread-v2": response = full
        case "/api/orchestration/threads/thread-v2/history": response = history
        default: throw URLError(.unsupportedURL)
        }
        return (try JSONEncoder.t3.encode(response), try #require(HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)))
    }
}
