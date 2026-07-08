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

        model.enqueue(.assistantDelta(threadID: "t1", messageID: "m1", delta: "a"))
        model.enqueue(.assistantDelta(threadID: "t1", messageID: "m1", delta: "b"))
        model.enqueue(.assistantDelta(threadID: "t1", messageID: "m1", delta: "c"))
        #expect(model.timelineVersion(threadID: "t1") == 0)

        model.flushPendingEvents()
        #expect(model.timelineVersion(threadID: "t1") == 1)

        // Empty flush must not bump.
        model.flushPendingEvents()
        #expect(model.timelineVersion(threadID: "t1") == 1)

        model.enqueue(.assistantDelta(threadID: "t1", messageID: "m1", delta: "d"))
        model.flushPendingEvents()
        #expect(model.timelineVersion(threadID: "t1") == 2)
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
