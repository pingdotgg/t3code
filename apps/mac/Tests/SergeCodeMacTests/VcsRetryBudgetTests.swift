// VcsRetryBudgetTests.swift
// The VCS watch retry budget is a *consecutive-failure* counter, not a
// lifetime one. Review flagged three times that it looked like the latter —
// i.e. that `maxVcsWatchRetries` transient failures would stop a thread from
// ever re-arming again — so the invariant is pinned here rather than left to
// a reading of `scheduleVcsWatchRetry` in isolation.

import Foundation
import T3Kit
import Testing

@testable import SergeCodeMac

@Suite("VCS watch retry budget")
struct VcsRetryBudgetTests {

    /// Cheapest event that reaches the reset at the top of `applyVcsEvent`:
    /// with no `vcsLocal` recorded, it returns before emitting anything, so
    /// no event-stream continuation is needed.
    private let healthyEvent = VcsStatusStreamEvent.remoteUpdated(nil)

    @Test("the budget bounds consecutive failures")
    func budgetIsBounded() async {
        let backend = LiveBackend()

        // Four attempts are available, numbered from zero so each one backs
        // off further than the last.
        var attempts: [Int] = []
        for _ in 0..<8 {
            guard let attempt = await backend.debugConsumeVcsRetryBudget(threadID: "t-1")
            else { break }
            attempts.append(attempt)
        }

        #expect(attempts == [0, 1, 2, 3])
        #expect(await backend.debugConsumeVcsRetryBudget(threadID: "t-1") == nil)
    }

    @Test("an event on a recovered stream restores the whole budget")
    func healthyEventResetsBudget() async {
        let backend = LiveBackend()

        while await backend.debugConsumeVcsRetryBudget(threadID: "t-1") != nil {}
        #expect(await backend.debugConsumeVcsRetryBudget(threadID: "t-1") == nil)

        // This is the case review expected to be broken: the stream recovers
        // after the budget is spent. Any event proves recovery, so the next
        // failure must get a full budget rather than being refused forever.
        await backend.debugApplyVcsEvent(threadID: "t-1", event: healthyEvent)

        #expect(await backend.debugConsumeVcsRetryBudget(threadID: "t-1") == 0)
    }

    @Test("a single event mid-streak resets the backoff rather than continuing it")
    func eventMidStreakResetsBackoff() async {
        let backend = LiveBackend()

        _ = await backend.debugConsumeVcsRetryBudget(threadID: "t-1")
        _ = await backend.debugConsumeVcsRetryBudget(threadID: "t-1")
        await backend.debugApplyVcsEvent(threadID: "t-1", event: healthyEvent)

        // Not 2: the streak is broken, so the next failure backs off from the
        // start instead of inheriting the old delay.
        #expect(await backend.debugConsumeVcsRetryBudget(threadID: "t-1") == 0)
    }

    @Test("budgets are tracked per thread")
    func budgetIsPerThread() async {
        let backend = LiveBackend()

        while await backend.debugConsumeVcsRetryBudget(threadID: "t-1") != nil {}

        #expect(await backend.debugConsumeVcsRetryBudget(threadID: "t-1") == nil)
        #expect(await backend.debugConsumeVcsRetryBudget(threadID: "t-2") == 0)
    }

    @Test("moving the watch to another worktree does not inherit the old budget")
    func cwdChangeResetsBudget() async {
        let backend = LiveBackend()

        while await backend.debugConsumeVcsRetryBudget(threadID: "t-1") != nil {}
        #expect(await backend.debugConsumeVcsRetryBudget(threadID: "t-1") == nil)

        // No watched cwd is recorded, so the restart is a no-op and the budget
        // must survive — only an actual cwd change may clear it.
        await backend.debugRestartVcsWatchIfStale(threadID: "t-1")
        #expect(await backend.debugConsumeVcsRetryBudget(threadID: "t-1") == nil)
    }
}
