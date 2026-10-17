import Foundation
import Testing
@testable import T3Code

@MainActor
@Suite("Native thread metadata")
struct NativeThreadMetadataTests {
    @Test func previewTextMatchesSplitAndJoinWithoutReadingTheWholeReply() {
        func reference(_ text: String?) -> String? {
            guard let text else { return nil }
            let compact = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
            guard !compact.isEmpty else { return nil }
            return compact.count > 160 ? "\(compact.prefix(157))..." : compact
        }
        let inputs: [String?] = [
            nil, "", " \n\t ", "  hello \n\t world  ",
            String(repeating: "a", count: 160), String(repeating: "a", count: 161),
            String(repeating: "word ", count: 10_000), " " + String(repeating: "é👍🏽 ", count: 60),
        ]
        for input in inputs {
            #expect(NativeFeatureClient.previewText(input) == reference(input))
        }
    }

    @Test
    func multiplePRSnapshotsReachThreadSearchAndExternalLinks() {
        let link = ThreadPullRequestLink(host: "github.example.com", repository: "test/other", number: 24,
            url: "https://github.example.com/test/other/pull/24", source: "manual",
            linkedAt: "2026-09-06T20:00:00Z", snapshot: nil, stack: nil)
        let feature = FeatureThread(id: "thread", projectID: "project", title: "Task", pullRequests: [link])
        #expect(ThreadPullRequestDestination.resolve(thread: feature, branchPullRequest: nil)?.url.absoluteString == link.url)
        #expect(ThreadPullRequests.searchTerms(feature.pullRequests, legacy: nil).contains("test/other#24"))
        var changed = feature
        changed.pullRequests = []
        #expect(HomeOrderKey(feature) != HomeOrderKey(changed))
        #expect(feature.pullRequestObservationIdentity == feature.pullRequestObservationIdentity)
        #expect(feature.pullRequestObservationIdentity != changed.pullRequestObservationIdentity)
    }

    @Test
    func snapshotsDecodeServerPRAndOrderWithoutRequiringThemFromOlderServers() throws {
        let base = try JSONValue.encode(thread())
        guard case var .object(fields) = base else {
            Issue.record("Expected an encoded thread")
            return
        }
        fields.removeValue(forKey: "branchPullRequest")
        fields.removeValue(forKey: "activeOrderKey")
        fields.removeValue(forKey: "pullRequests")
        let older = try JSONValue.object(fields).decode(OrchestrationThread.self)
        #expect(older.branchPullRequest == nil)
        #expect(older.activeOrderKey == nil)
        #expect(older.pullRequests == nil)

        fields["branchPullRequest"] = try JSONValue.encode(reference())
        fields["activeOrderKey"] = .string("nm")
        fields["pullRequests"] = .array([])
        let current = try JSONValue.object(fields).decode(OrchestrationThread.self)
        #expect(current.branchPullRequest == reference())
        #expect(current.activeOrderKey == "nm")
        #expect(current.pullRequests == [])

        fields["latestUserMessageAt"] = .null
        fields["hasPendingApprovals"] = .bool(false)
        fields["hasPendingUserInput"] = .bool(false)
        fields["hasActionableProposedPlan"] = .bool(false)
        let shell = try JSONValue.object(fields).decode(OrchestrationThreadShell.self)
        #expect(shell.branchPullRequest == reference())
        #expect(shell.activeOrderKey == "nm")
        #expect(shell.pullRequests == [])
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

    @Test func v2MetadataUpdatesPreserveMessagesAndCarrySettlementAndPullRequests() throws {
        let link = try JSONValue.encode(reference())
        let regeneration = try JSONValue.encode(ThreadTitleRegeneration(requestId: "title", startedAt: V2Fixture.now))
        var state = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot(
            items: [V2Fixture.assistant("answer", ordinal: 1)], fields: ["thread": V2Fixture.patch(V2Fixture.thread, [
                "autoSettleDisabledAt": .string(V2Fixture.now), "titleRegeneration": regeneration,
            ])]))
        let settled = V2Fixture.patch(state.projection.thread.raw, [
            "settledOverride": .string("settled"), "settledAt": .string(V2Fixture.now),
            "activeOrderKey": .null, "branchPullRequest": link,
        ])
        #expect(!state.apply([V2Fixture.event("thread.settled", payload: settled, sequence: 11)]).refreshRequired)
        var detail = state.normalizedSnapshot().thread
        #expect(detail.autoSettleDisabledAt == V2Fixture.now)
        #expect(detail.branchPullRequest == reference())
        #expect(detail.activeOrderKey == nil)
        #expect(detail.titleRegeneration?.requestId == "title")
        #expect(detail.messages.first?.text == "Answer")

        let reopened = V2Fixture.patch(settled, [
            "settledOverride": .string("active"), "settledAt": .null,
            "unsettledAt": .string(V2Fixture.now), "autoSettleDisabledAt": .null,
            "activeOrderKey": .string("nm"), "branchPullRequest": .null,
        ])
        #expect(!state.apply([V2Fixture.event("thread.unsettled", payload: reopened, sequence: 12)]).refreshRequired)
        detail = state.normalizedSnapshot().thread
        #expect(detail.unsettledAt == V2Fixture.now)
        #expect(detail.autoSettleDisabledAt == nil)
        #expect(detail.activeOrderKey == "nm")
        #expect(detail.branchPullRequest == nil)
        #expect(detail.titleRegeneration?.requestId == "title")
    }

    @Test func malformedV2MetadataRequiresARefresh() throws {
        var state = try OrchestrationV2ThreadState(snapshot: V2Fixture.snapshot())
        let invalid = V2Fixture.patch(V2Fixture.thread, ["activeOrderKey": .number(10)])
        #expect(state.apply([V2Fixture.event("thread.metadata-updated", payload: invalid, sequence: 11)]).refreshRequired)
        #expect(state.snapshotSequence == 10)
    }

    @Test func dismissedPullRequestStackMembersStayHidden() {
        let link = ThreadPullRequestLink(host: "github.com", repository: "test/repo", number: 2,
            url: "https://github.com/test/repo/pull/2", source: "stack-dismissed",
            linkedAt: V2Fixture.now, snapshot: nil, stack: nil)
        let feature = FeatureThread(id: "thread", projectID: "project", title: "Task", pullRequests: [link])
        #expect(feature.effectivePullRequest == nil)
        #expect(ThreadPullRequestDestination.resolve(thread: feature, branchPullRequest: nil) == nil)
        #expect(HomeThreadPullRequestPresentation.resolve(links: [link]) == nil)
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
