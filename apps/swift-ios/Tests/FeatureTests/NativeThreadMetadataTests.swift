import Foundation
import Testing
@testable import T3Code

@MainActor
@Suite("Native thread metadata")
struct NativeThreadMetadataTests {
    @Test
    func snapshotsDecodeServerPRAndOrderWithoutRequiringThemFromOlderServers() throws {
        let base = try JSONValue.encode(thread())
        guard case var .object(fields) = base else {
            Issue.record("Expected an encoded thread")
            return
        }
        fields.removeValue(forKey: "branchPullRequest")
        fields.removeValue(forKey: "activeOrderKey")
        let older = try JSONValue.object(fields).decode(OrchestrationThread.self)
        #expect(older.branchPullRequest == nil)
        #expect(older.activeOrderKey == nil)

        fields["branchPullRequest"] = try JSONValue.encode(reference())
        fields["activeOrderKey"] = .string("nm")
        let current = try JSONValue.object(fields).decode(OrchestrationThread.self)
        #expect(current.branchPullRequest == reference())
        #expect(current.activeOrderKey == "nm")

        fields["latestUserMessageAt"] = .null
        fields["hasPendingApprovals"] = .bool(false)
        fields["hasPendingUserInput"] = .bool(false)
        fields["hasActionableProposedPlan"] = .bool(false)
        let shell = try JSONValue.object(fields).decode(OrchestrationThreadShell.self)
        #expect(shell.branchPullRequest == reference())
        #expect(shell.activeOrderKey == "nm")
    }

    @Test
    func branchPRAndActiveOrderUpdatesDoNotReloadTheThread() throws {
        let branchUpdate = try reduce(
            ["branchPullRequest": JSONValue.encode(reference())],
            thread: thread()
        )
        #expect(branchUpdate.branchPullRequest == reference())
        #expect(branchUpdate.linkedPullRequest == nil)

        let reordered = try reduce(["activeOrderKey": .string("nm")], thread: branchUpdate)
        #expect(reordered.branchPullRequest == reference())
        #expect(reordered.activeOrderKey == "nm")

        let cleared = try reduce([
            "branchPullRequest": .null,
            "activeOrderKey": .null,
        ], thread: reordered)
        #expect(cleared.branchPullRequest == nil)
        #expect(cleared.activeOrderKey == nil)
    }

    @Test
    func settlingClearsManualOrderButKeepsPRMetadata() throws {
        var source = thread()
        source.branchPullRequest = reference()
        source.activeOrderKey = "nm"
        let result = NativeThreadDetailReducer.apply(event(
            type: "thread.settled",
            payload: ["settledAt": .string("2026-09-06T20:00:00Z")]
        ), to: source)
        guard case let .updated(settled) = result.result else {
            Issue.record("Expected settlement without a reload")
            return
        }
        #expect(settled.activeOrderKey == nil)
        #expect(settled.branchPullRequest == reference())
    }

    @Test
    func settlingAndMetadataUpdatesKeepAnActiveTitleRegeneration() throws {
        var source = thread()
        source.titleRegeneration = ThreadTitleRegeneration(
            requestId: "command-regenerate", startedAt: "2026-09-06T19:30:00Z"
        )
        let settled = NativeThreadDetailReducer.apply(event(
            type: "thread.settled",
            payload: ["settledAt": .string("2026-09-06T20:00:00Z")]
        ), to: source)
        guard case let .updated(afterSettle) = settled.result else {
            Issue.record("Expected settlement without a reload")
            return
        }
        #expect(afterSettle.titleRegeneration == source.titleRegeneration)

        let reordered = try reduce(["activeOrderKey": .string("nm")], thread: afterSettle)
        #expect(reordered.titleRegeneration == source.titleRegeneration)
    }

    @Test
    func ordinaryThreadEventsPreservePRAndManualOrder() throws {
        var source = thread()
        source.branchPullRequest = reference()
        source.activeOrderKey = "nm"
        let result = NativeThreadDetailReducer.apply(event(
            type: "thread.message-sent",
            payload: [
                "messageId": .string("message"),
                "role": .string("assistant"),
                "text": .string("Complete"),
                "streaming": .bool(false),
                "createdAt": .string("2026-09-06T20:00:00Z"),
            ]
        ), to: source)
        guard case let .updated(updated) = result.result else {
            Issue.record("Expected the message to update without a reload")
            return
        }
        #expect(updated.branchPullRequest == reference())
        #expect(updated.activeOrderKey == "nm")
        #expect(updated.messages.last?.text == "Complete")
    }

    @Test
    func invalidMetadataStillRequestsAnAuthoritativeSnapshot() {
        let payloads: [[String: JSONValue]] = [
            ["branchPullRequest": .string("invalid")],
            ["activeOrderKey": .number(10)],
            ["activeOrderKey": .string(" ")],
            ["branchPullRequest": .null, "title": .string("Renamed")],
        ]
        for payload in payloads {
            let result = NativeThreadDetailReducer.apply(event(payload: payload), to: thread())
            #expect(result.result == .refresh)
        }
    }

    @Test
    func serverPRLinksOpenDirectlyAndExplicitLinksTakePriority() throws {
        var source = FeatureThread(
            id: "thread", projectID: "project", title: "Task",
            branchPullRequest: reference()
        )
        let branchIdentity = source.pullRequestObservationIdentity
        #expect(branchIdentity != nil)
        let branchDestination = try #require(ThreadPullRequestDestination.resolve(
            thread: source, branchPullRequest: nil
        ))
        #expect(branchDestination.url.absoluteString == reference().url)
        #expect(branchDestination.number == 1)

        source.linkedPullRequest = reference(number: 2)
        #expect(source.effectivePullRequest == reference(number: 2))
        #expect(source.pullRequestObservationIdentity != branchIdentity)
        let linkedDestination = try #require(ThreadPullRequestDestination.resolve(
            thread: source, branchPullRequest: nil
        ))
        #expect(linkedDestination.number == 2)
    }

    private func reduce(
        _ payload: [String: JSONValue],
        thread: OrchestrationThread
    ) throws -> OrchestrationThread {
        let reduction = NativeThreadDetailReducer.apply(event(payload: payload), to: thread)
        #expect(reduction.renderMutation == .metadata)
        guard case let .updated(updated) = reduction.result else {
            throw MetadataTestError.expectedLocalUpdate
        }
        return updated
    }

    private func event(
        type: String = "thread.meta-updated",
        payload: [String: JSONValue]
    ) -> JSONValue {
        .object([
            "type": .string(type),
            "sequence": .number(2),
            "occurredAt": .string("2026-09-06T20:00:00Z"),
            "payload": .object(payload.merging([
                "threadId": .string("thread"),
                "updatedAt": .string("2026-09-06T20:00:00Z"),
            ]) { _, value in value }),
        ])
    }

    private func reference(number: Int = 1) -> ThreadLinkedPullRequest {
        ThreadLinkedPullRequest(
            projectId: "project", repository: "test/repo", number: number,
            url: "https://example.com/pull/\(number)"
        )
    }

    private func thread() -> OrchestrationThread {
        OrchestrationThread(
            id: "thread", projectId: "project", title: "Task",
            modelSelection: ModelSelection(instanceId: "codex", model: "gpt-5.6-sol"),
            runtimeMode: .fullAccess, interactionMode: .default,
            branch: "task", worktreePath: nil, latestTurn: nil,
            createdAt: "2026-09-06T19:00:00Z", updatedAt: "2026-09-06T19:00:00Z",
            archivedAt: nil, settledOverride: nil, settledAt: nil,
            snoozedUntil: nil, snoozedAt: nil, pinnedAt: nil, deletedAt: nil,
            messages: [], activities: [], checkpoints: [], session: nil
        )
    }
}

private enum MetadataTestError: Error {
    case expectedLocalUpdate
}
