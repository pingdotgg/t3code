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
            .userMessage(id: "user-1", text: "hello", at: date),
            .assistantMessage(id: "assistant-1", markdown: "old", isStreaming: true, at: date),
        ]

        _ = grouped(initialItems, timelineVersion: 1, structureVersion: 1)
        #expect(TimelineDisplayCache.fullPassCount == 1)

        let refreshedItems: [TimelineItem] = [
            .userMessage(id: "user-1", text: "hello", at: date),
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
