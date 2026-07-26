import AppKit
import Testing

@testable import SergeCodeMac

@Suite("Haptics policy")
struct HapticsPolicyTests {
    private let profile = HapticsProfile(isEnabled: true)

    @Test("navigation ticks, levels step, work thuds")
    func patternMapping() {
        #expect(profile.pattern(for: .selection) == .alignment)
        #expect(profile.pattern(for: .toggle) == .alignment)
        #expect(profile.pattern(for: .boundary) == .alignment)
        #expect(profile.pattern(for: .step) == .levelChange)
        #expect(profile.pattern(for: .decision) == .levelChange)
        #expect(profile.pattern(for: .commit) == .generic)
        #expect(profile.pattern(for: .failure) == .generic)
    }

    @Test("state-change feedback waits for the frame, dispatch does not")
    func performanceTimeMapping() {
        #expect(profile.performanceTime(for: .selection) == .drawCompleted)
        #expect(profile.performanceTime(for: .step) == .drawCompleted)
        #expect(profile.performanceTime(for: .commit) == .now)
        #expect(profile.performanceTime(for: .success) == .now)
    }

    @Test("only outcomes get a second tap")
    func tapCounts() {
        #expect(profile.tapCount(for: .success) == 2)
        #expect(profile.tapCount(for: .failure) == 2)
        for event in HapticEvent.allCases where event != .success && event != .failure {
            #expect(profile.tapCount(for: event) == 1)
        }
    }

    @Test("every event has a pattern and lands within the responsiveness budget")
    func coverage() {
        for event in HapticEvent.allCases {
            _ = profile.pattern(for: event)
            _ = profile.performanceTime(for: event)
        }
        // The second tap must read as part of the same beat, not as a
        // separate later event.
        #expect(profile.outcomeTapDelay <= 0.15)
        #expect(profile.repeatFloor >= profile.eventFloor)
    }
}

@Suite("Haptics throttle")
struct HapticsThrottleTests {
    private let profile = HapticsProfile(isEnabled: true)

    /// `#expect` can't call a mutating member, so each admission is taken
    /// into a local first.
    private func admissions(
        _ taps: [(HapticEvent, TimeInterval, HapticsProfile)]
    ) -> [Bool] {
        var throttle = HapticsThrottle()
        return taps.map { throttle.admits($0.0, at: $0.1, profile: $0.2) }
    }

    @Test("the first tap always plays")
    func firstTap() {
        #expect(admissions([(.selection, 100, profile)]) == [true])
    }

    @Test("key repeat collapses to one tick per floor")
    func repeatedSameEvent() {
        let played = admissions([
            (.selection, 100, profile),
            (.selection, 100.02, profile),
            (.selection, 100.2, profile),
        ])
        #expect(played == [true, false, true])
    }

    @Test("one gesture firing two events is felt once")
    func distinctEventsWithinFloor() {
        let played = admissions([
            (.selection, 100, profile),
            (.commit, 100.005, profile),
            (.commit, 100.1, profile),
        ])
        #expect(played == [true, false, true])
    }

    @Test("the preference suppresses everything, and suppressed taps cost nothing")
    func disabled() {
        let off = HapticsProfile(isEnabled: false)
        let played = admissions([
            (.success, 100, off),
            (.success, 100, profile),
        ])
        #expect(played == [false, true])
    }

    @Test("an outcome's trailing tap plays when nothing intervened")
    func outcomeTailUndisturbed() {
        var throttle = HapticsThrottle()
        let leading = throttle.admits(.success, at: 100, profile: profile)
        let ticket = throttle.admittedCount
        let tail = throttle.admitsOutcomeTail(
            .success, ticket: ticket, at: 100.12, profile: profile)
        #expect(leading)
        #expect(tail)
    }

    @Test("a trailing tap is dropped once the preference is off")
    func outcomeTailAfterDisabling() {
        var throttle = HapticsThrottle()
        _ = throttle.admits(.failure, at: 100, profile: profile)
        let ticket = throttle.admittedCount
        let tail = throttle.admitsOutcomeTail(
            .failure, ticket: ticket, at: 100.12,
            profile: HapticsProfile(isEnabled: false))
        #expect(!tail)
    }

    @Test("a tap during the delay cancels the trailing tap instead of stacking on it")
    func outcomeTailAfterInterveningTap() {
        var throttle = HapticsThrottle()
        _ = throttle.admits(.success, at: 100, profile: profile)
        let ticket = throttle.admittedCount
        let intervening = throttle.admits(.commit, at: 100.06, profile: profile)
        let tail = throttle.admitsOutcomeTail(
            .success, ticket: ticket, at: 100.12, profile: profile)
        #expect(intervening)
        #expect(!tail)
    }

    @Test("a delivered trailing tap still spaces whatever comes next")
    func outcomeTailConsumesTheWindow() {
        var throttle = HapticsThrottle()
        _ = throttle.admits(.success, at: 100, profile: profile)
        let ticket = throttle.admittedCount
        _ = throttle.admitsOutcomeTail(.success, ticket: ticket, at: 100.12, profile: profile)
        let immediatelyAfter = throttle.admits(.selection, at: 100.125, profile: profile)
        let later = throttle.admits(.selection, at: 100.3, profile: profile)
        #expect(!immediatelyAfter)
        #expect(later)
    }
}

@Suite("Thread status haptics")
struct ThreadStatusHapticsTests {
    private func snapshot(
        _ id: String?, _ status: ThreadStatus?, cancellationPending: Bool = false
    ) -> ThreadStatusSnapshot {
        ThreadStatusSnapshot(
            threadID: id, status: status, cancellationPending: cancellationPending)
    }

    @Test("a finished run on the watched thread reports success")
    func runFinished() {
        #expect(
            ThreadStatusHaptics.event(
                from: snapshot("t1", .running), to: snapshot("t1", .idle)) == .success)
        #expect(
            ThreadStatusHaptics.event(
                from: snapshot("t1", .running), to: snapshot("t1", .done)) == .success)
    }

    @Test("blocked runs ask, failures report")
    func blockedAndFailed() {
        #expect(
            ThreadStatusHaptics.event(
                from: snapshot("t1", .running), to: snapshot("t1", .waitingApproval)) == .decision)
        #expect(
            ThreadStatusHaptics.event(
                from: snapshot("t1", .running), to: snapshot("t1", .waitingInput)) == .decision)
        #expect(
            ThreadStatusHaptics.event(
                from: snapshot("t1", .running), to: snapshot("t1", .error)) == .failure)
    }

    @Test("switching threads never reports the new thread's resting state")
    func threadSwitchIsSilent() {
        #expect(
            ThreadStatusHaptics.event(
                from: snapshot("t1", .running), to: snapshot("t2", .idle)) == nil)
        #expect(
            ThreadStatusHaptics.event(from: snapshot(nil, nil), to: snapshot("t1", .idle)) == nil)
    }

    @Test("housekeeping between settled states is silent")
    func settledTransitions() {
        #expect(
            ThreadStatusHaptics.event(
                from: snapshot("t1", .idle), to: snapshot("t1", .settled)) == nil)
        #expect(
            ThreadStatusHaptics.event(
                from: snapshot("t1", .idle), to: snapshot("t1", .idle)) == nil)
        // Starting a run is felt at the composer, not here.
        #expect(
            ThreadStatusHaptics.event(
                from: snapshot("t1", .idle), to: snapshot("t1", .running)) == nil)
    }

    @Test("a run the user stopped is not announced as a success")
    func cancelledRunIsSilent() {
        #expect(
            ThreadStatusHaptics.event(
                from: snapshot("t1", .running),
                to: snapshot("t1", .idle, cancellationPending: true)) == nil)
        // The stamp only silences the turn that was actually cancelled; the
        // next run reports normally.
        #expect(
            ThreadStatusHaptics.event(
                from: snapshot("t1", .running),
                to: snapshot("t1", .idle, cancellationPending: false)) == .success)
    }

    @Test("only an executing run can complete")
    func successRequiresAnExecutingRun() {
        // Waiting on the user, then settling, is an abandoned turn — the
        // decision that ended it already tapped.
        for waiting in [ThreadStatus.waiting, .waitingApproval, .waitingInput] {
            #expect(
                ThreadStatusHaptics.event(
                    from: snapshot("t1", waiting), to: snapshot("t1", .idle)) == nil)
        }
        for executing in [ThreadStatus.running, .backgroundWork, .reviewing, .fixing] {
            #expect(
                ThreadStatusHaptics.event(
                    from: snapshot("t1", executing), to: snapshot("t1", .idle)) == .success)
        }
    }

    @Test("dispositions applied to a finished thread never tap")
    func dispositionsAreSilent() {
        // `settled` is the user filing a thread away (that button taps
        // itself), `readyToMerge` is a derived review state — neither is the
        // moment a run completed.
        #expect(
            ThreadStatusHaptics.event(
                from: snapshot("t1", .running), to: snapshot("t1", .settled)) == nil)
        #expect(
            ThreadStatusHaptics.event(
                from: snapshot("t1", .running), to: snapshot("t1", .readyToMerge)) == nil)
        #expect(
            ThreadStatusHaptics.event(
                from: snapshot("t1", .running), to: snapshot("t1", .archived)) == nil)
    }
}

/// Serialized: the actuator seam, the throttle, and the preference are all
/// process-wide, so these cases must not interleave with each other.
@Suite("Haptics playback", .serialized)
@MainActor
struct HapticsPlaybackTests {
    @Test("play routes the mapped pattern through the performer")
    func routesPattern() {
        var played: [(NSHapticFeedbackManager.FeedbackPattern, NSHapticFeedbackManager.PerformanceTime)] = []
        Haptics.resetThrottleForTesting()
        Haptics.actuator = { pattern, time in played.append((pattern, time)) }
        defer { Haptics.actuator = nil }

        HapticsPreferences.isEnabled = true
        Haptics.play(.commit, at: 1_000)

        #expect(played.count == 1)
        #expect(played.first?.0 == .generic)
        #expect(played.first?.1 == .now)
    }

    @Test("the preference gates playback")
    func preferenceGate() {
        var count = 0
        Haptics.resetThrottleForTesting()
        Haptics.actuator = { _, _ in count += 1 }
        defer {
            Haptics.actuator = nil
            HapticsPreferences.isEnabled = true
        }

        HapticsPreferences.isEnabled = false
        Haptics.play(.commit, at: 2_000)
        #expect(count == 0)

        HapticsPreferences.isEnabled = true
        Haptics.play(.commit, at: 2_001)
        #expect(count == 1)
    }

    @Test("an outcome plays twice end to end")
    func outcomePlaysTwice() async throws {
        var played: [NSHapticFeedbackManager.FeedbackPattern] = []
        Haptics.resetThrottleForTesting()
        Haptics.actuator = { pattern, _ in played.append(pattern) }
        defer { Haptics.actuator = nil }
        HapticsPreferences.isEnabled = true

        Haptics.play(.success)
        #expect(played.count == 1)

        try await Task.sleep(for: .milliseconds(300))
        #expect(played == [.levelChange, .levelChange])
    }

    @Test("switching haptics off during the delay drops the trailing tap")
    func outcomeTailStopsWhenDisabledMidDelay() async throws {
        var played = 0
        Haptics.resetThrottleForTesting()
        Haptics.actuator = { _, _ in played += 1 }
        defer {
            Haptics.actuator = nil
            HapticsPreferences.isEnabled = true
        }
        HapticsPreferences.isEnabled = true

        Haptics.play(.failure)
        #expect(played == 1)
        HapticsPreferences.isEnabled = false

        try await Task.sleep(for: .milliseconds(300))
        #expect(played == 1)
    }

    @Test("turning the preference off still confirms itself, and turning it on does too")
    func preferenceAcknowledgement() {
        var played = 0
        Haptics.actuator = { _, _ in played += 1 }
        defer {
            Haptics.actuator = nil
            HapticsPreferences.isEnabled = true
        }

        HapticsPreferences.isEnabled = true
        Haptics.resetThrottleForTesting()
        Haptics.setPreference(enabled: false)
        #expect(played == 1)
        #expect(!HapticsPreferences.isEnabled)

        Haptics.resetThrottleForTesting()
        Haptics.setPreference(enabled: true)
        #expect(played == 2)
        #expect(HapticsPreferences.isEnabled)
    }

    @Test("conditional play skips when the action did nothing")
    func conditionalPlay() {
        var count = 0
        Haptics.resetThrottleForTesting()
        Haptics.actuator = { _, _ in count += 1 }
        defer { Haptics.actuator = nil }
        HapticsPreferences.isEnabled = true

        Haptics.play(.boundary, when: false)
        #expect(count == 0)
    }
}
