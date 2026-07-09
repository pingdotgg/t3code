import Foundation
import Testing

@testable import SergeCodeMac

// Exercises the AppModel event batch reducer directly: events are enqueued
// and flushed by hand (no backend stream, no 33ms timer), asserting the
// per-flush transaction semantics that keep MainActor churn bounded.

@Suite("AppModel event batching")
@MainActor
struct AppModelBatchingTests {
    private func makeModel() -> AppModel {
        AppModel(backend: MockBackend())
    }

    private func delta(_ threadID: String, _ messageID: String, _ text: String) -> BackendEvent {
        .assistantDelta(threadID: threadID, messageID: messageID, delta: text)
    }

    @Test("deltas buffer until flush, then land as one message")
    func deltasBufferUntilFlush() {
        let model = makeModel()
        model.enqueue(delta("t1", "m1", "Hel"))
        model.enqueue(delta("t1", "m1", "lo "))
        model.enqueue(delta("t1", "m1", "world"))
        #expect(model.threadState("t1")?.timeline == nil)

        model.flushPendingEvents()
        let items = model.threadState("t1")?.timeline ?? []
        #expect(items.count == 1)
        guard case .assistantMessage(let id, let markdown, let isStreaming, _) = items.first else {
            Issue.record("expected assistant message, got \(items)")
            return
        }
        #expect(id == "m1")
        #expect(markdown == "Hello world")
        #expect(isStreaming)
    }

    @Test("arrival order is preserved across staged timeline writes")
    func orderPreserved() {
        let model = makeModel()
        model.enqueue(
            .timelineAppended(
                threadID: "t1",
                item: .userMessage(id: "u1", text: "hi", at: Date(timeIntervalSince1970: 1))))
        model.enqueue(delta("t1", "m1", "partial"))
        model.enqueue(.assistantCompleted(threadID: "t1", messageID: "m1", markdown: "final text"))
        model.flushPendingEvents()

        let items = model.threadState("t1")?.timeline ?? []
        #expect(items.count == 2)
        #expect(items.first?.id == "u1")
        guard case .assistantMessage(_, let markdown, let isStreaming, _) = items.last else {
            Issue.record("expected assistant message, got \(items)")
            return
        }
        // assistantCompleted's markdown is authoritative over local deltas.
        #expect(markdown == "final text")
        #expect(!isStreaming)
    }

    @Test("interleaved threads each get their own single write")
    func interleavedThreads() {
        let model = makeModel()
        model.enqueue(delta("a", "m1", "A1"))
        model.enqueue(delta("b", "m2", "B1"))
        model.enqueue(delta("a", "m1", "A2"))
        model.flushPendingEvents()

        guard case .assistantMessage(_, let aText, _, _) = (model.threadState("a")?.timeline ?? []).first,
            case .assistantMessage(_, let bText, _, _) = (model.threadState("b")?.timeline ?? []).first
        else {
            Issue.record("expected one assistant message per thread")
            return
        }
        #expect(aText == "A1A2")
        #expect(bText == "B1")
    }

    @Test("connection events flush the buffer immediately")
    func connectionFlushesImmediately() {
        let model = makeModel()
        model.enqueue(delta("t1", "m1", "queued"))
        #expect(model.threadState("t1")?.timeline == nil)
        model.enqueue(.connection(.ready))
        #expect(model.threadState("t1")?.timeline.count == 1)
        #expect(model.connection == .ready)
    }

    @Test("buffer cap forces a flush under bursts")
    func bufferCapFlushes() {
        let model = makeModel()
        for index in 0..<AppModel.maxPendingEvents {
            model.enqueue(delta("t1", "m1", "x\(index) "))
        }
        // The cap-triggered flush must have applied without an explicit call.
        #expect((model.threadState("t1")?.timeline ?? []).count == 1)
    }

    @Test("approval resolution removes the card via the keyed map")
    func approvalResolvedKeyed() {
        let model = makeModel()
        let request = ApprovalRequest(
            id: "ap1", threadID: "t1", kind: .command, title: "Run", detail: "ls",
            createdAt: Date())
        model.enqueue(.timelineAppended(threadID: "t1", item: .approval(request)))
        model.flushPendingEvents()
        #expect(model.threadState("t1")?.timeline.count == 1)

        model.enqueue(.approvalResolved(id: "ap1"))
        model.flushPendingEvents()
        #expect(model.threadState("t1")?.timeline.isEmpty == true)
    }

    @Test("approval resolution falls back to a scan for snapshot-loaded items")
    func approvalResolvedFallback() {
        let model = makeModel()
        let request = ApprovalRequest(
            id: "ap2", threadID: "t1", kind: .command, title: "Run", detail: "ls",
            createdAt: Date())
        // Empty reset creates ThreadState without seeding interactionThreadByID.
        // Writing the approval onto the timeline directly mimics a snapshot
        // load that bypassed events (map miss → full-thread scan fallback).
        model.enqueue(.timelineReset(threadID: "t1", items: []))
        model.flushPendingEvents()
        model.threadState("t1")!.timeline = [.approval(request)]

        model.enqueue(.approvalResolved(id: "ap2"))
        model.flushPendingEvents()
        #expect(model.threadState("t1")?.timeline.isEmpty == true)
    }

    @Test("stale streaming index after reset rescans instead of mis-writing")
    func staleStreamingIndexRecovers() {
        let model = makeModel()
        model.enqueue(delta("t1", "m1", "first"))
        model.flushPendingEvents()

        // Reset replaces the array (index invalidated), with the message at
        // a different position.
        model.enqueue(
            .timelineReset(
                threadID: "t1",
                items: [
                    .userMessage(id: "u1", text: "hi", at: Date(timeIntervalSince1970: 1)),
                    .assistantMessage(
                        id: "m1", markdown: "first", isStreaming: true,
                        at: Date(timeIntervalSince1970: 2)),
                ]))
        model.flushPendingEvents()

        model.enqueue(delta("t1", "m1", " second"))
        model.flushPendingEvents()

        let items = model.threadState("t1")?.timeline ?? []
        #expect(items.count == 2)
        guard case .assistantMessage(_, let markdown, _, _) = items.last else {
            Issue.record("expected assistant message last, got \(items)")
            return
        }
        #expect(markdown == "first second")
    }

    @Test("tool lifecycle upserts replace rows in place within one flush")
    func toolUpsertWithinFlush() {
        let model = makeModel()
        model.enqueue(
            .timelineAppended(
                threadID: "t1",
                item: .toolEvent(
                    id: "tool1", name: "Bash", detail: "ls", kind: .command, status: .running,
                    at: Date(timeIntervalSince1970: 1), output: nil, outputIsError: false)))
        model.enqueue(
            .timelineAppended(
                threadID: "t1",
                item: .toolEvent(
                    id: "tool1", name: "Bash", detail: "ls", kind: .command, status: .succeeded,
                    at: Date(timeIntervalSince1970: 2), output: "ok", outputIsError: false)))
        model.flushPendingEvents()

        let items = model.threadState("t1")?.timeline ?? []
        #expect(items.count == 1)
        guard case .toolEvent(_, _, _, _, let status, _, _, _) = items.first else {
            Issue.record("expected tool event, got \(items)")
            return
        }
        #expect(status == .succeeded)
    }

    @Test("mutating thread B does not change thread A's identity or timeline")
    func threadIsolationPreservesSiblingState() {
        let model = makeModel()
        model.enqueue(delta("A", "mA", "hello A"))
        model.flushPendingEvents()

        let stateA = model.threadState("A")
        #expect(stateA != nil)
        #expect(stateA?.timeline.count == 1)
        guard case .assistantMessage(_, let aTextBefore, _, _) = stateA?.timeline.first else {
            Issue.record("expected assistant message on A")
            return
        }
        #expect(aTextBefore == "hello A")
        #expect(model.timelineVersion(threadID: "A") == 1)
        #expect(model.timelineVersion(threadID: "B") == 0)

        model.enqueue(delta("B", "mB", "hello B"))
        model.flushPendingEvents()

        // Sibling child object identity is stable; only B's timeline/version moves.
        #expect(model.threadState("A") === stateA)
        #expect(model.threadState("A")?.timeline.count == 1)
        guard case .assistantMessage(_, let aTextAfter, _, _) = model.threadState("A")?.timeline.first
        else {
            Issue.record("expected assistant message still on A")
            return
        }
        #expect(aTextAfter == "hello A")
        #expect(model.timelineVersion(threadID: "A") == 1)
        #expect(model.timelineVersion(threadID: "B") == 1)
        #expect((model.threadState("B")?.timeline ?? []).count == 1)
    }
}
