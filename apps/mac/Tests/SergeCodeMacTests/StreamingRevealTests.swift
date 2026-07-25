import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Streaming reveal")
@MainActor
struct StreamingRevealTests {
    private let policy = StreamingRevealPolicy(reduceMotion: false)

    // MARK: Policy

    @Test("advance is monotonic and never exceeds the target")
    func policyMonotonic() {
        var revealed = 0
        var tick = Date(timeIntervalSinceReferenceDate: 0)
        for _ in 0..<100 {
            let next = policy.advancedRevealCount(
                current: revealed, target: 1_000, elapsed: 1.0 / 120)
            #expect(next >= revealed)
            #expect(next <= 1_000)
            revealed = next
            tick.addTimeInterval(1.0 / 120)
        }
        _ = tick
    }

    @Test("a slow trickle still advances by the minimum step")
    func policyMinStep() {
        // Backlog of 1 byte: the catch-up term is ~0, the floor keeps motion.
        let next = policy.advancedRevealCount(current: 500, target: 501, elapsed: 1.0 / 120)
        #expect(next > 500)
    }

    @Test("larger backlog catches up proportionally faster")
    func policyCatchUp() {
        let small = policy.advancedRevealCount(current: 0, target: 50, elapsed: 1.0 / 60)
        let large = policy.advancedRevealCount(current: 0, target: 500, elapsed: 1.0 / 60)
        #expect(large > small)
    }

    @Test("huge backlog snaps instantly instead of typing out")
    func policyInstantSnap() {
        let next = policy.advancedRevealCount(current: 0, target: 10_000, elapsed: 1.0 / 60)
        #expect(next == 10_000)
    }

    @Test("Reduce Motion reveals everything immediately")
    func policyReduceMotion() {
        let reduced = StreamingRevealPolicy(reduceMotion: true)
        #expect(reduced.advancedRevealCount(current: 3, target: 500, elapsed: 1.0 / 60) == 500)
    }

    @Test("no backlog stays put")
    func policyCaughtUp() {
        #expect(policy.advancedRevealCount(current: 100, target: 100, elapsed: 1.0 / 60) == 100)
    }

    // MARK: Grapheme safety

    @Test("reveal never splits a multi-byte scalar or composed grapheme")
    func graphemeSafety() {
        let target = "Hi 👨‍👩‍👧‍👦 e\u{0301} 🇫🇷 end"
        let total = target.utf8.count
        for budget in 0...total {
            let safe = StreamingRevealStore.graphemeSafeRevealCount(
                of: target, utf8ByteCount: budget)
            #expect(safe <= budget)
            let prefix = String(target.utf8.prefix(safe))!
            // The prefix must be exactly a concatenation of whole Characters.
            #expect(String(prefix).utf8.count == safe)
            #expect(target.hasPrefix(prefix))
            // And no Character in the target straddles the cut.
            if safe < total {
                let remainder = target.dropFirst(prefix.count)
                #expect(prefix.count + remainder.count == target.count)
            }
        }
    }

    // MARK: Store

    @Test("store reveals append-only targets progressively to completion")
    func storeProgressiveReveal() {
        StreamingRevealStore.resetForTesting()
        defer { StreamingRevealStore.resetForTesting() }

        let target = String(repeating: "streaming text ", count: 20) // 300 bytes
        var now = Date(timeIntervalSinceReferenceDate: 0)
        var seen = ""
        var advanced = 0
        for _ in 0..<2_000 {
            now.addTimeInterval(1.0 / 120)
            if StreamingRevealStore.advance(
                threadID: "t", messageID: "m", target: target, at: now, policy: policy)
            {
                advanced += 1
            }
            let current = StreamingRevealStore.revealed(
                threadID: "t", messageID: "m", target: target)
            #expect(target.hasPrefix(current))
            #expect(current.utf8.count >= seen.utf8.count)
            seen = current
            if seen == target { break }
        }
        #expect(seen == target)
        #expect(advanced > 1) // glided over many frames, not one jump
    }

    @Test("growing targets extend the same reveal without rewinding")
    func storeGrowingTarget() {
        StreamingRevealStore.resetForTesting()
        defer { StreamingRevealStore.resetForTesting() }

        var now = Date(timeIntervalSinceReferenceDate: 0)
        var last = ""
        for chunk in ["The agent ", "is writing ", "a reply ", "in chunks."] {
            now.addTimeInterval(1.0 / 30)
            let target = last + chunk
            _ = StreamingRevealStore.advance(
                threadID: "t", messageID: "m", target: target, at: now, policy: policy)
            let revealed = StreamingRevealStore.revealed(
                threadID: "t", messageID: "m", target: target)
            #expect(target.hasPrefix(revealed))
            #expect(revealed.utf8.count >= last.utf8.count)
            last = target
        }
        #expect(StreamingRevealStore.resetCount == 0)
    }

    @Test("a replaced (non-append-only) target resets the reveal")
    func storeDivergenceReset() {
        StreamingRevealStore.resetForTesting()
        defer { StreamingRevealStore.resetForTesting() }

        var now = Date(timeIntervalSinceReferenceDate: 0)
        _ = StreamingRevealStore.advance(
            threadID: "t", messageID: "m", target: "Hello world", at: now, policy: policy)
        let before = StreamingRevealStore.revealed(
            threadID: "t", messageID: "m", target: "Hello world")
        #expect(!before.isEmpty)

        now.addTimeInterval(1.0 / 60)
        _ = StreamingRevealStore.advance(
            threadID: "t", messageID: "m", target: "Jello world", at: now, policy: policy)
        #expect(StreamingRevealStore.resetCount == 1)
        let after = StreamingRevealStore.revealed(
            threadID: "t", messageID: "m", target: "Jello world")
        #expect("Jello world".hasPrefix(after))
    }

    @Test("finish drops the session so a reused key starts fresh")
    func storeFinish() {
        StreamingRevealStore.resetForTesting()
        defer { StreamingRevealStore.resetForTesting() }

        let now = Date(timeIntervalSinceReferenceDate: 0)
        _ = StreamingRevealStore.advance(
            threadID: "t", messageID: "m", target: "some text", at: now, policy: policy)
        #expect(
            !StreamingRevealStore.revealed(threadID: "t", messageID: "m", target: "some text")
                .isEmpty)

        StreamingRevealStore.finish(threadID: "t", messageID: "m")
        #expect(
            StreamingRevealStore.revealed(threadID: "t", messageID: "m", target: "some text")
                .isEmpty)
    }

    @Test("evict drops every session for a thread")
    func storeEvict() {
        StreamingRevealStore.resetForTesting()
        defer { StreamingRevealStore.resetForTesting() }

        let now = Date(timeIntervalSinceReferenceDate: 0)
        for message in ["a", "b"] {
            _ = StreamingRevealStore.advance(
                threadID: "t", messageID: message, target: "text", at: now, policy: policy)
        }
        StreamingRevealStore.evict(threadID: "t")
        #expect(StreamingRevealStore.revealed(threadID: "t", messageID: "a", target: "text").isEmpty)
        #expect(StreamingRevealStore.revealed(threadID: "t", messageID: "b", target: "text").isEmpty)
    }
}
