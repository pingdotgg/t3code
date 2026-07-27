import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Streaming reveal")
@MainActor
struct StreamingRevealTests {
    /// Live-stream pacing: warm-up hold plus the long catch-up window.
    private let policy = StreamingRevealPolicy(reduceMotion: false)
    /// Stream-ended pacing: no hold, brisk final drain. Store tests use this
    /// so small targets reveal instead of sitting in the warm-up hold.
    private let finalPolicy = StreamingRevealPolicy(reduceMotion: false, isFinal: true)

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
        let small = policy.advancedRevealCount(current: 600, target: 650, elapsed: 1.0 / 60)
        let large = policy.advancedRevealCount(current: 600, target: 2_600, elapsed: 1.0 / 60)
        #expect(large - 600 > small - 600)
    }

    @Test("a live stream holds at zero until the warm-up buffer fills")
    func policyWarmUpHold() {
        // Below the warm-up threshold a live stream reveals nothing yet...
        #expect(policy.advancedRevealCount(current: 0, target: 200, elapsed: 1.0 / 60) == 0)
        // ...and above it the glide starts.
        #expect(policy.advancedRevealCount(current: 0, target: 600, elapsed: 1.0 / 60) > 0)
    }

    @Test("a final target skips the warm-up hold")
    func policyFinalSkipsWarmUp() {
        // A short response buffered in full starts its glide immediately.
        #expect(finalPolicy.advancedRevealCount(current: 0, target: 200, elapsed: 1.0 / 60) > 0)
    }

    @Test("a final target drains its backlog faster than a live stream")
    func policyFinalDrainsFaster() {
        let live = policy.advancedRevealCount(current: 0, target: 2_000, elapsed: 1.0 / 60)
        let final = finalPolicy.advancedRevealCount(current: 0, target: 2_000, elapsed: 1.0 / 60)
        #expect(final > live)
    }

    @Test("huge backlog snaps instantly instead of typing out")
    func policyInstantSnap() {
        let next = policy.advancedRevealCount(current: 0, target: 20_000, elapsed: 1.0 / 60)
        #expect(next == 20_000)
    }

    @Test("ordinary streaming backlog never snaps mid-message")
    func policyNoSnapBelowThreshold() {
        // 10 KB was the old snap threshold; a live stream must now glide
        // through it rather than jump.
        let next = policy.advancedRevealCount(current: 0, target: 10_000, elapsed: 1.0 / 60)
        #expect(next < 10_000)
        #expect(next > 0)
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
                threadID: "t", messageID: "m", target: target, at: now, policy: finalPolicy)
            {
                advanced += 1
            }
            let current = StreamingRevealStore.revealed(
                threadID: "t", messageID: "m", target: target, at: now)
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
            let target = last + chunk
            // Several frames per flush: the reveal glides a little further
            // each tick instead of jumping the whole chunk at once.
            for _ in 0..<3 {
                now.addTimeInterval(1.0 / 30)
                _ = StreamingRevealStore.advance(
                    threadID: "t", messageID: "m", target: target, at: now,
                    policy: finalPolicy)
            }
            let revealed = StreamingRevealStore.revealed(
                threadID: "t", messageID: "m", target: target, at: now)
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
            threadID: "t", messageID: "m", target: "Hello world", at: now, policy: finalPolicy)
        let before = StreamingRevealStore.revealed(
            threadID: "t", messageID: "m", target: "Hello world", at: now)
        #expect(!before.isEmpty)

        now.addTimeInterval(1.0 / 60)
        _ = StreamingRevealStore.advance(
            threadID: "t", messageID: "m", target: "Jello world", at: now, policy: finalPolicy)
        #expect(StreamingRevealStore.resetCount == 1)
        let after = StreamingRevealStore.revealed(
            threadID: "t", messageID: "m", target: "Jello world", at: now)
        #expect("Jello world".hasPrefix(after))
    }

    @Test("hasPendingReveal reports buffered backlog without creating sessions")
    func storeHasPendingReveal() {
        StreamingRevealStore.resetForTesting()
        defer { StreamingRevealStore.resetForTesting() }

        // No session: nothing pending, and the query must not create one —
        // a finished message rendered from history stays settled.
        #expect(
            !StreamingRevealStore.hasPendingReveal(
                threadID: "t", messageID: "m", target: "hello world"))
        #expect(
            StreamingRevealStore.revealed(threadID: "t", messageID: "m", target: "hello world")
                .isEmpty)
        StreamingRevealStore.resetForTesting()

        // Partially revealed: backlog pending.
        var now = Date(timeIntervalSinceReferenceDate: 0)
        _ = StreamingRevealStore.advance(
            threadID: "t", messageID: "m", target: "hello world", at: now, policy: finalPolicy)
        #expect(
            StreamingRevealStore.hasPendingReveal(
                threadID: "t", messageID: "m", target: "hello world", at: now))

        // Fully drained: nothing pending.
        for _ in 0..<100 {
            now.addTimeInterval(1.0 / 30)
            _ = StreamingRevealStore.advance(
                threadID: "t", messageID: "m", target: "hello world", at: now, policy: finalPolicy)
        }
        #expect(
            StreamingRevealStore.revealed(
                threadID: "t", messageID: "m", target: "hello world", at: now) == "hello world")
        #expect(
            !StreamingRevealStore.hasPendingReveal(
                threadID: "t", messageID: "m", target: "hello world", at: now))
    }

    @Test("finish drops the session so a reused key starts fresh")
    func storeFinish() {
        StreamingRevealStore.resetForTesting()
        defer { StreamingRevealStore.resetForTesting() }

        let now = Date(timeIntervalSinceReferenceDate: 0)
        _ = StreamingRevealStore.advance(
            threadID: "t", messageID: "m", target: "some text", at: now, policy: finalPolicy)
        #expect(
            !StreamingRevealStore.revealed(
                threadID: "t", messageID: "m", target: "some text", at: now).isEmpty)

        StreamingRevealStore.finish(threadID: "t", messageID: "m")
        #expect(
            StreamingRevealStore.revealed(
                threadID: "t", messageID: "m", target: "some text", at: now).isEmpty)
    }

    // MARK: Adoption

    @Test("a fresh stream's first flush is small enough to still type out")
    func adoptionLeavesFreshStreamsAlone() {
        let adoption = StreamingRevealAdoption()
        // A ~30 Hz flush is tens of bytes; the warm-up buffer is the ceiling
        // on what a live stream can hold before it starts revealing.
        #expect(!adoption.shouldAdoptOnCreate(targetUTF8Count: 0))
        #expect(!adoption.shouldAdoptOnCreate(targetUTF8Count: 120))
        #expect(!adoption.shouldAdoptOnCreate(targetUTF8Count: adoption.mountAdoptionBytes - 1))
        // Mounting into a message this long means the view was not here when
        // the text arrived — selecting a thread whose agent is mid-run.
        #expect(adoption.shouldAdoptOnCreate(targetUTF8Count: adoption.mountAdoptionBytes))
        #expect(adoption.shouldAdoptOnCreate(targetUTF8Count: 20_000))
    }

    @Test("only a gap far longer than a display tick counts as stale")
    func adoptionResumeRule() {
        let adoption = StreamingRevealAdoption()
        let now = Date(timeIntervalSinceReferenceDate: 1_000)
        // Never ticked: the session is brand new, not stale.
        #expect(!adoption.shouldAdoptOnResume(lastTick: nil, now: now))
        // A watched reveal ticks every display frame, and deltas land at
        // ~30 Hz — both are far inside the window.
        #expect(!adoption.shouldAdoptOnResume(lastTick: now.addingTimeInterval(-1.0 / 120), now: now))
        #expect(!adoption.shouldAdoptOnResume(lastTick: now.addingTimeInterval(-1.0 / 30), now: now))
        #expect(!adoption.shouldAdoptOnResume(lastTick: now.addingTimeInterval(-0.5), now: now))
        // Nothing drove it for a second: the user was somewhere else.
        #expect(adoption.shouldAdoptOnResume(lastTick: now.addingTimeInterval(-1), now: now))
        #expect(adoption.shouldAdoptOnResume(lastTick: now.addingTimeInterval(-30), now: now))
    }

    @Test("selecting a thread mid-run adopts the message instead of retyping it")
    func storeAdoptsOnMountIntoLiveMessage() {
        StreamingRevealStore.resetForTesting()
        defer { StreamingRevealStore.resetForTesting() }

        // A run the user was not watching has already produced this much.
        let inFlight = String(repeating: "already streamed ", count: 60) // ~1 KB
        let now = Date(timeIntervalSinceReferenceDate: 0)
        #expect(
            StreamingRevealStore.revealed(
                threadID: "t", messageID: "m", target: inFlight, at: now) == inFlight)
        #expect(StreamingRevealStore.adoptionCount == 1)
        #expect(
            !StreamingRevealStore.hasPendingReveal(
                threadID: "t", messageID: "m", target: inFlight, at: now))
    }

    @Test("text that arrives after an adopted mount still glides")
    func storeGlidesAfterAdoptedMount() {
        StreamingRevealStore.resetForTesting()
        defer { StreamingRevealStore.resetForTesting() }

        let mounted = String(repeating: "already streamed ", count: 60)
        var now = Date(timeIntervalSinceReferenceDate: 0)
        _ = StreamingRevealStore.revealed(
            threadID: "t", messageID: "m", target: mounted, at: now)

        // One more flush lands while the row is on screen: it types out
        // rather than snapping, which is the whole point of the reveal.
        let grown = mounted + String(repeating: "and more text ", count: 20)
        now.addTimeInterval(1.0 / 30)
        _ = StreamingRevealStore.advance(
            threadID: "t", messageID: "m", target: grown, at: now, policy: policy)
        let partial = StreamingRevealStore.revealed(
            threadID: "t", messageID: "m", target: grown, at: now)
        #expect(partial.utf8.count > mounted.utf8.count)
        #expect(partial.utf8.count < grown.utf8.count)
        #expect(StreamingRevealStore.adoptionCount == 1) // no second adoption
    }

    @Test("leaving a thread mid-run and returning finished renders settled")
    func storeAdoptsAfterThreadSwitch() {
        StreamingRevealStore.resetForTesting()
        defer { StreamingRevealStore.resetForTesting() }

        // Watching the stream: the reveal is mid-glide and lagging behind.
        let partialTarget = String(repeating: "watched text ", count: 30)
        var now = Date(timeIntervalSinceReferenceDate: 0)
        for _ in 0..<3 {
            now.addTimeInterval(1.0 / 120)
            _ = StreamingRevealStore.advance(
                threadID: "t", messageID: "m", target: partialTarget, at: now, policy: policy)
        }
        #expect(
            StreamingRevealStore.hasPendingReveal(
                threadID: "t", messageID: "m", target: partialTarget, at: now))

        // The user switches away, the run finishes, and they come back to a
        // settled thread. Nothing drove the session in between.
        let finalTarget = partialTarget + String(repeating: "unwatched text ", count: 30)
        now.addTimeInterval(20)
        #expect(
            !StreamingRevealStore.hasPendingReveal(
                threadID: "t", messageID: "m", target: finalTarget, at: now))
        #expect(StreamingRevealStore.adoptionCount == 1)
        // Which means the row renders through the settled full-document path
        // with the whole message already on screen.
        #expect(
            StreamingRevealStore.revealed(
                threadID: "t", messageID: "m", target: finalTarget, at: now) == finalTarget)
    }

    @Test("adoption keeps the append-only invariant, so no divergence reset")
    func storeAdoptionDoesNotDiverge() {
        StreamingRevealStore.resetForTesting()
        defer { StreamingRevealStore.resetForTesting() }

        let mounted = String(repeating: "seed ", count: 120) // > warm-up buffer
        var now = Date(timeIntervalSinceReferenceDate: 0)
        _ = StreamingRevealStore.revealed(
            threadID: "t", messageID: "m", target: mounted, at: now)
        now.addTimeInterval(1.0 / 30)
        _ = StreamingRevealStore.advance(
            threadID: "t", messageID: "m", target: mounted + "tail", at: now, policy: policy)
        #expect(StreamingRevealStore.resetCount == 0)
    }

    @Test("evict drops every session for a thread")
    func storeEvict() {
        StreamingRevealStore.resetForTesting()
        defer { StreamingRevealStore.resetForTesting() }

        let now = Date(timeIntervalSinceReferenceDate: 0)
        for message in ["a", "b"] {
            _ = StreamingRevealStore.advance(
                threadID: "t", messageID: message, target: "text", at: now, policy: finalPolicy)
        }
        StreamingRevealStore.evict(threadID: "t")
        #expect(
            StreamingRevealStore.revealed(
                threadID: "t", messageID: "a", target: "text", at: now).isEmpty)
        #expect(
            StreamingRevealStore.revealed(
                threadID: "t", messageID: "b", target: "text", at: now).isEmpty)
    }
}
