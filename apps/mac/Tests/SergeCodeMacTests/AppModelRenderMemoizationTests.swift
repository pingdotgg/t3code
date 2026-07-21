import Foundation
import Testing

@testable import SergeCodeMac

// Render-layer memoization helpers on AppModel: timeline version bumps and
// sidebar no-op upsert suppression for updatedAt-only activity bumps.

@Suite("AppModel render memoization")
@MainActor
struct AppModelRenderMemoizationTests {
    private func makeModel() -> AppModel {
        AppModel(backend: MockBackend())
    }

    private func makeThread(
        id: String = "t1",
        title: String = "Session",
        status: ThreadStatus = .idle,
        updatedAt: Date = Date(timeIntervalSince1970: 100)
    ) -> ChatThread {
        ChatThread(
            id: id,
            projectID: "p1",
            title: title,
            provider: .codex,
            status: status,
            updatedAt: updatedAt)
    }

    @Test("timelineVersion bumps once per flush per touched thread")
    func timelineVersionBumpsOncePerFlush() {
        let model = makeModel()
        #expect(model.timelineVersion(threadID: "t1") == 0)
        #expect(model.timelineStructureVersion(threadID: "t1") == 0)

        model.enqueue(.assistantDelta(threadID: "t1", messageID: "m1", delta: "a"))
        model.enqueue(.assistantDelta(threadID: "t1", messageID: "m1", delta: "b"))
        model.enqueue(.assistantDelta(threadID: "t1", messageID: "m1", delta: "c"))
        #expect(model.timelineVersion(threadID: "t1") == 0)

        model.flushPendingEvents()
        #expect(model.timelineVersion(threadID: "t1") == 1)
        // The first delta creates the assistant row, so it is structural.
        #expect(model.timelineStructureVersion(threadID: "t1") == 1)

        // Empty flush must not bump.
        model.flushPendingEvents()
        #expect(model.timelineVersion(threadID: "t1") == 1)
        #expect(model.timelineStructureVersion(threadID: "t1") == 1)

        model.enqueue(.assistantDelta(threadID: "t1", messageID: "m1", delta: "d"))
        model.flushPendingEvents()
        #expect(model.timelineVersion(threadID: "t1") == 2)
        // This delta updates the existing assistant row in place.
        #expect(model.timelineStructureVersion(threadID: "t1") == 1)
    }

    @Test("structural timeline writes bump both versions")
    func structuralTimelineWritesBumpBothVersions() {
        let model = makeModel()
        let date = Date(timeIntervalSince1970: 1)

        model.enqueue(
            .timelineAppended(
                threadID: "t1", item: .userMessage(id: "u1", text: "hello", at: date)))
        model.flushPendingEvents()
        #expect(model.timelineVersion(threadID: "t1") == 1)
        #expect(model.timelineStructureVersion(threadID: "t1") == 1)

        model.enqueue(
            .timelineReset(
                threadID: "t1",
                items: [.assistantMessage(id: "m1", markdown: "reply", isStreaming: false, at: date)]))
        model.flushPendingEvents()
        #expect(model.timelineVersion(threadID: "t1") == 2)
        #expect(model.timelineStructureVersion(threadID: "t1") == 2)

        model.enqueue(
            .timelineAppended(
                threadID: "t1",
                item: .toolEvent(
                    id: "tool1", name: "Bash", detail: "ls", kind: .command, status: .running,
                    at: date, output: nil, outputIsError: false)))
        model.flushPendingEvents()
        #expect(model.timelineVersion(threadID: "t1") == 3)
        #expect(model.timelineStructureVersion(threadID: "t1") == 3)

        model.enqueue(
            .timelineAppended(
                threadID: "t1",
                item: .toolEvent(
                    id: "tool1", name: "Bash", detail: "ls", kind: .command, status: .succeeded,
                    at: date.addingTimeInterval(1), output: nil, outputIsError: false)))
        model.flushPendingEvents()
        #expect(model.timelineVersion(threadID: "t1") == 4)
        #expect(model.timelineStructureVersion(threadID: "t1") == 4)
    }

    @Test("subagent progress refreshes content without regrouping the transcript")
    func subagentProgressIsContentOnly() {
        let model = makeModel()
        let startedAt = Date(timeIntervalSince1970: 1)

        func task(progress: String) -> TimelineItem {
            .subagentTask(
                SubagentTaskItem(
                    taskId: "agent-1",
                    taskType: "sub-agent",
                    description: "Inspect the repository",
                    state: .running,
                    latestProgress: progress,
                    startedAt: startedAt,
                    lastActivityAt: startedAt,
                    duration: nil))
        }

        model.enqueue(.timelineAppended(threadID: "t1", item: task(progress: "Starting")))
        model.flushPendingEvents()
        #expect(model.timelineVersion(threadID: "t1") == 1)
        #expect(model.timelineStructureVersion(threadID: "t1") == 1)

        model.enqueue(.timelineAppended(threadID: "t1", item: task(progress: "Reading files")))
        model.flushPendingEvents()

        #expect(model.timelineVersion(threadID: "t1") == 2)
        #expect(model.timelineStructureVersion(threadID: "t1") == 1)
        guard case .subagentTask(let refreshed) = model.timeline(threadID: "t1").first else {
            Issue.record("expected a subagent task row")
            return
        }
        #expect(refreshed.latestProgress == "Reading files")
    }

    @Test("updatedAt-only threadUpserted does not rewrite the sidebar list")
    func updatedAtOnlyUpsertSkipsRewrite() {
        let model = makeModel()
        let base = makeThread(updatedAt: Date(timeIntervalSince1970: 100))
        model.enqueue(.threadUpserted(base))
        model.flushPendingEvents()
        #expect(model.threads.count == 1)
        #expect(model.threads[0].updatedAt == Date(timeIntervalSince1970: 100))
        #expect(model.threads[0].status == .idle)

        // Activity bump: same display fields, newer updatedAt only.
        var bumped = base
        bumped.updatedAt = Date(timeIntervalSince1970: 200)
        model.enqueue(.threadUpserted(bumped))
        model.flushPendingEvents()

        // List content equals the pre-bump snapshot (stored updatedAt stays).
        #expect(model.threads.count == 1)
        #expect(model.threads[0] == base)
        #expect(model.threads[0].updatedAt == Date(timeIntervalSince1970: 100))
        #expect(model.threads[0].status == .idle)

        // A genuine change still lands.
        var statusChange = bumped
        statusChange.status = .running
        model.enqueue(.threadUpserted(statusChange))
        model.flushPendingEvents()

        #expect(model.threads.count == 1)
        #expect(model.threads[0].status == .running)
        #expect(model.threads[0].updatedAt == Date(timeIntervalSince1970: 200))
    }

    @Test("displayEquivalent ignores only updatedAt")
    func displayEquivalentComparesAllButUpdatedAt() {
        let a = makeThread(updatedAt: Date(timeIntervalSince1970: 1))
        var b = a
        b.updatedAt = Date(timeIntervalSince1970: 999)
        #expect(a.displayEquivalent(to: b))

        b.status = .running
        #expect(!a.displayEquivalent(to: b))

        b = a
        b.title = "Other"
        #expect(!a.displayEquivalent(to: b))
    }
}
