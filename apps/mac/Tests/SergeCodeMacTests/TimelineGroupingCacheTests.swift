import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Timeline grouping cache", .serialized)
@MainActor
struct TimelineGroupingCacheTests {
    private func grouped(
        _ items: [TimelineItem],
        threadID: String = "cache-thread",
        timelineVersion: Int,
        structureVersion: Int,
        threadIsSettled: Bool = false
    ) -> [TimelineDisplayItem] {
        TimelineDisplayCache.grouped(
            items: items,
            threadID: threadID,
            version: timelineVersion,
            structureVersion: structureVersion,
            threadIsSettled: threadIsSettled)
    }

    private func tool(id: String, at date: Date) -> TimelineItem {
        .toolEvent(
            id: id,
            name: "Bash",
            detail: "ls",
            kind: .command,
            status: .succeeded,
            at: date,
            output: nil,
            outputIsError: false)
    }

    @Test("content refresh updates assistant markdown without a full pass")
    func contentRefreshUpdatesAssistantMarkdown() {
        TimelineDisplayCache.resetForTesting()
        let date = Date(timeIntervalSince1970: 1)
        let initialItems: [TimelineItem] = [
            .userMessage(id: "user-1", text: "hello", attachments: [], at: date),
            .assistantMessage(id: "assistant-1", markdown: "old", isStreaming: true, at: date),
        ]

        _ = grouped(initialItems, timelineVersion: 1, structureVersion: 1)
        #expect(TimelineDisplayCache.fullPassCount == 1)

        let refreshedItems: [TimelineItem] = [
            .userMessage(id: "user-1", text: "hello", attachments: [], at: date),
            .assistantMessage(
                id: "assistant-1", markdown: "new markdown", isStreaming: true, at: date),
        ]
        let refreshed = grouped(refreshedItems, timelineVersion: 2, structureVersion: 1)

        #expect(TimelineDisplayCache.fullPassCount == 1)
        #expect(TimelineDisplayCache.contentRefreshCount == 1)
        guard case .single(let item) = refreshed.last,
            case .assistantMessage(_, let markdown, _, _) = item
        else {
            Issue.record("expected refreshed assistant message, got \(refreshed)")
            return
        }
        #expect(markdown == "new markdown")
    }

    // The next two tests deliberately use their own thread key and assert on the
    // returned rows rather than the cache's global counters, so they can run
    // alongside the other suites that reset those counters.

    @Test("content refresh reuses every row it did not have to change")
    func contentRefreshReusesUntouchedRows() {
        let date = Date(timeIntervalSince1970: 1)
        func items(assistantMarkdown: String) -> [TimelineItem] {
            [
                .userMessage(id: "user-1", text: "hello", attachments: [], at: date),
                .notice(id: "notice-1", text: "heads up", at: date),
                .assistantMessage(
                    id: "assistant-1", markdown: assistantMarkdown, isStreaming: true, at: date),
            ]
        }

        let initial = grouped(
            items(assistantMarkdown: "a"), threadID: "row-reuse-thread",
            timelineVersion: 1, structureVersion: 1)
        let refreshed = grouped(
            items(assistantMarkdown: "ab"), threadID: "row-reuse-thread",
            timelineVersion: 2, structureVersion: 1)

        // Only the streaming assistant row changed. The rows above it must come
        // back equal, which is what lets ChatTimelineRowView skip their bodies
        // instead of re-rendering the whole transcript on every delta.
        #expect(refreshed.count == initial.count)
        #expect(refreshed[0] == initial[0])
        #expect(refreshed[1] == initial[1])
        #expect(refreshed[2] != initial[2])
    }

    @Test("content refresh rebuilds a tool group whose items changed")
    func contentRefreshRebuildsChangedToolGroup() {
        let date = Date(timeIntervalSince1970: 1)
        func timeline(secondToolOutput: String?) -> [TimelineItem] {
            [
                tool(id: "tool-1", at: date),
                .toolEvent(
                    id: "tool-2", name: "Bash", detail: "pwd", kind: .command,
                    status: .succeeded, at: date.addingTimeInterval(1),
                    output: secondToolOutput, outputIsError: false),
                .assistantMessage(id: "assistant-1", markdown: "done", isStreaming: true, at: date),
            ]
        }

        let initial = grouped(
            timeline(secondToolOutput: nil), threadID: "tool-group-refresh-thread",
            timelineVersion: 1, structureVersion: 1)
        let refreshed = grouped(
            timeline(secondToolOutput: "/tmp"), threadID: "tool-group-refresh-thread",
            timelineVersion: 2, structureVersion: 1)

        guard case .toolGroup = initial[0], case .toolGroup = refreshed[0] else {
            Issue.record("expected a tool group at index 0, got \(refreshed)")
            return
        }
        // The group's tool gained output, so its row must be rebuilt; the
        // untouched assistant row must not.
        #expect(initial[0] != refreshed[0])
        #expect(initial[1] == refreshed[1])
    }

    @Test("tool group identity stays stable across content refresh")
    func toolGroupIdentityStaysStable() {
        TimelineDisplayCache.resetForTesting()
        let date = Date(timeIntervalSince1970: 1)
        let initialItems: [TimelineItem] = [
            tool(id: "tool-1", at: date),
            tool(id: "tool-2", at: date.addingTimeInterval(1)),
            .assistantMessage(id: "assistant-1", markdown: "old", isStreaming: true, at: date),
        ]
        let initial = grouped(initialItems, timelineVersion: 1, structureVersion: 1)

        guard case .toolGroup(let initialID, let initialGroupItems, let initialSummary) = initial[0]
        else {
            Issue.record("expected initial tool group, got \(initial)")
            return
        }

        let refreshedItems: [TimelineItem] = [
            tool(id: "tool-1", at: date),
            tool(id: "tool-2", at: date.addingTimeInterval(1)),
            .assistantMessage(
                id: "assistant-1", markdown: "new", isStreaming: true, at: date),
        ]
        let refreshed = grouped(refreshedItems, timelineVersion: 2, structureVersion: 1)

        guard case .toolGroup(let refreshedID, let refreshedGroupItems, let refreshedSummary) = refreshed[0]
        else {
            Issue.record("expected refreshed tool group, got \(refreshed)")
            return
        }
        #expect(initialID == refreshedID)
        #expect(initialGroupItems.map(\.id) == refreshedGroupItems.map(\.id))
        #expect(initialSummary == refreshedSummary)
        #expect(TimelineDisplayCache.fullPassCount == 1)
        #expect(TimelineDisplayCache.contentRefreshCount == 1)
    }

    @Test("usage-limit removal forces a structural regroup")
    func usageLimitRemovalTriggersRegroup() {
        TimelineDisplayCache.resetForTesting()
        let model = AppModel(backend: MockBackend())
        let date = Date(timeIntervalSince1970: 1)
        let notice = UsageLimitNotice(
            id: "usage-1",
            threadID: "t1",
            provider: .codex,
            providerName: "Codex",
            message: "Limit reached",
            resetsAt: nil,
            createdAt: date)

        model.enqueue(.timelineAppended(threadID: "t1", item: tool(id: "tool-1", at: date)))
        model.enqueue(
            .timelineAppended(
                threadID: "t1", item: tool(id: "tool-2", at: date.addingTimeInterval(1))))
        model.enqueue(.timelineAppended(threadID: "t1", item: .usageLimit(notice)))
        model.flushPendingEvents()

        let beforeItems = model.threadState("t1")?.timeline ?? []
        let before = grouped(
            beforeItems,
            threadID: "t1",
            timelineVersion: model.timelineVersion(threadID: "t1"),
            structureVersion: model.timelineStructureVersion(threadID: "t1"))
        #expect(before.count == 2)
        guard case .toolGroup = before[0] else {
            Issue.record("expected usage notice to close a tool group, got \(before)")
            return
        }
        #expect(TimelineDisplayCache.fullPassCount == 1)

        model.dismissUsageLimit(notice)
        #expect(model.timelineVersion(threadID: "t1") == 2)
        #expect(model.timelineStructureVersion(threadID: "t1") == 2)

        let afterItems = model.threadState("t1")?.timeline ?? []
        let after = grouped(
            afterItems,
            threadID: "t1",
            timelineVersion: model.timelineVersion(threadID: "t1"),
            structureVersion: model.timelineStructureVersion(threadID: "t1"))
        #expect(TimelineDisplayCache.fullPassCount == 2)
        #expect(after.count == 2)
        #expect(after.allSatisfy { item in
            if case .single = item { return true }
            return false
        })
    }
}
