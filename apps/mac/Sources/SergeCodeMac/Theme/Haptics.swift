import AppKit
import SwiftUI

/// The physical half of the app's feedback language: what a control feels
/// like when it responds. `Motion` owns the pixels, this owns the taps.
///
/// Events are semantic rather than pattern-named so call sites describe what
/// happened ("this committed work") instead of picking an AppKit pattern, and
/// the mapping stays tunable in one place.
enum HapticEvent: String, CaseIterable, Sendable {
    /// A discrete choice landed: menu row, segment, list step.
    case selection
    /// A binary state flipped.
    case toggle
    /// One step along a range: reasoning effort, zoom, slider detent.
    case step
    /// The range refused to move: already at the first/last file, min/max zoom.
    case boundary
    /// The user committed work: send, queue, create, run.
    case commit
    /// A deliberate yes/no on something the agent asked for.
    case decision
    /// A rare good outcome: merged PR, finished git action.
    case success
    /// The action failed or was refused.
    case failure
}

/// Pure haptics policy: which AppKit pattern an event plays, when it plays
/// relative to the frame, and how closely two taps may follow each other.
/// Keeping it free of AppKit calls makes the mapping and the anti-buzz rules
/// directly testable.
struct HapticsProfile: Equatable, Sendable {
    let isEnabled: Bool

    /// Two taps of the *same* event closer than this read as one smeared
    /// buzz, so the second is dropped. Sized for key-repeat: holding ⌘⌥↓ to
    /// walk a diff ticks per file instead of vibrating continuously.
    let repeatFloor: TimeInterval = 0.05
    /// Floor between any two taps. One gesture often fires two events (a
    /// picker row selects *and* commits); only the first should be felt.
    let eventFloor: TimeInterval = 0.02
    /// Spacing of the second tap for two-tap outcomes.
    let outcomeTapDelay: TimeInterval = 0.12

    /// Light tick for navigation, firmer level change for stepping and
    /// decisions, generic thud for the things that actually did work.
    func pattern(for event: HapticEvent) -> NSHapticFeedbackManager.FeedbackPattern {
        switch event {
        case .selection, .toggle, .boundary: .alignment
        case .step, .decision, .success: .levelChange
        case .commit, .failure: .generic
        }
    }

    /// Feedback that annotates a visible change lands with the frame that
    /// shows it; feedback for work that was dispatched fires immediately, so
    /// the tap isn't held hostage by a slow redraw.
    func performanceTime(for event: HapticEvent) -> NSHapticFeedbackManager.PerformanceTime {
        switch event {
        case .selection, .toggle, .step, .boundary: .drawCompleted
        case .commit, .decision, .success, .failure: .now
        }
    }

    /// Outcomes get a second tap so they read as a result rather than as
    /// another click.
    func tapCount(for event: HapticEvent) -> Int {
        switch event {
        case .success, .failure: 2
        default: 1
        }
    }
}

/// Rate limiter keeping rapid call sites (key repeat, slider drags, a picker
/// row that both selects and commits) from turning discrete taps into a buzz.
struct HapticsThrottle: Equatable {
    private var lastByEvent: [HapticEvent: TimeInterval] = [:]
    private var lastAny: TimeInterval?
    /// Counts admitted taps. A two-tap outcome takes a ticket with its leading
    /// tap and presents it again for the trailing one, so anything felt in
    /// between cancels the tail rather than stacking a third tap on top.
    private(set) var admittedCount = 0

    init() {}

    /// Returns true — and records the tap — when `event` may be played at
    /// `now`. `now` is a monotonic clock reading (`systemUptime`), not a date.
    mutating func admits(
        _ event: HapticEvent, at now: TimeInterval, profile: HapticsProfile
    ) -> Bool {
        guard profile.isEnabled else { return false }
        if let lastAny, now - lastAny < profile.eventFloor { return false }
        if let last = lastByEvent[event], now - last < profile.repeatFloor { return false }
        record(event, at: now)
        return true
    }

    /// Admission for the trailing tap of a two-tap outcome, decided at
    /// delivery rather than at scheduling: the preference can be switched off
    /// during the delay, and any tap admitted in the meantime means the
    /// outcome's feedback window already belongs to something else.
    ///
    /// Deliberately no floor check — the delay is chosen by the profile, and
    /// `ticket` already proves nothing else has been felt since.
    mutating func admitsOutcomeTail(
        _ event: HapticEvent, ticket: Int, at now: TimeInterval, profile: HapticsProfile
    ) -> Bool {
        guard profile.isEnabled, admittedCount == ticket else { return false }
        record(event, at: now)
        return true
    }

    private mutating func record(_ event: HapticEvent, at now: TimeInterval) {
        lastByEvent[event] = now
        lastAny = now
        admittedCount += 1
    }
}

/// App-wide entry point for trackpad feedback. Every call site goes through
/// `Haptics.play` so the preference, the throttle, and the pattern mapping
/// apply everywhere.
///
/// Hardware: `NSHapticFeedbackManager` is a no-op without a Force Touch
/// trackpad, so nothing here needs a capability check.
@MainActor
enum Haptics {
    /// Test seam. When set, replaces the AppKit performer so policy and
    /// throttling can be exercised without an actuator.
    static var actuator:
        ((NSHapticFeedbackManager.FeedbackPattern, NSHapticFeedbackManager.PerformanceTime) -> Void)?

    private static var throttle = HapticsThrottle()

    static var profile: HapticsProfile {
        HapticsProfile(isEnabled: HapticsPreferences.isEnabled)
    }

    /// Plays `event` unless the preference is off or the throttle swallows it.
    static func play(_ event: HapticEvent, at now: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        let profile = profile
        guard throttle.admits(event, at: now, profile: profile) else { return }
        let pattern = profile.pattern(for: event)
        actuate(pattern, profile.performanceTime(for: event))
        guard profile.tapCount(for: event) > 1 else { return }
        let ticket = throttle.admittedCount
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(profile.outcomeTapDelay))
            playOutcomeTail(event, ticket: ticket)
        }
    }

    /// Trailing tap of a two-tap outcome. Every gate is re-evaluated here
    /// rather than inherited from the leading tap: `outcomeTapDelay` is long
    /// enough for the user to switch haptics off, or for another action to
    /// claim the feedback window, between the two halves.
    static func playOutcomeTail(
        _ event: HapticEvent, ticket: Int,
        at now: TimeInterval = ProcessInfo.processInfo.systemUptime
    ) {
        let profile = profile
        guard throttle.admitsOutcomeTail(event, ticket: ticket, at: now, profile: profile)
        else { return }
        actuate(profile.pattern(for: event), .now)
    }

    /// `play` for the very common "only if the action actually did something"
    /// shape, e.g. a step that may be at the end of its range.
    static func play(_ event: HapticEvent, when condition: Bool) {
        guard condition else { return }
        play(event)
    }

    /// Plays `success` or `failure` from a boolean outcome.
    static func playOutcome(success: Bool) {
        play(success ? .success : .failure)
    }

    /// Persists a change to the haptics preference and acknowledges it.
    ///
    /// The tap is played on whichever side of the write still has haptics
    /// enabled, so switching *off* gets one last confirmation instead of the
    /// switch going silent under the finger — the preference demonstrates
    /// itself in both directions.
    static func setPreference(enabled: Bool) {
        if enabled {
            HapticsPreferences.isEnabled = true
            play(.toggle)
        } else {
            play(.toggle)
            HapticsPreferences.isEnabled = false
        }
    }

    /// Drops recorded taps so a test starts from a clean throttle.
    static func resetThrottleForTesting() {
        throttle = HapticsThrottle()
    }

    private static func actuate(
        _ pattern: NSHapticFeedbackManager.FeedbackPattern,
        _ time: NSHapticFeedbackManager.PerformanceTime
    ) {
        if let actuator {
            actuator(pattern, time)
            return
        }
        NSHapticFeedbackManager.defaultPerformer.perform(pattern, performanceTime: time)
    }
}

/// Identity + status of the thread on screen, so a status haptic can tell a
/// real transition from "the user switched to a thread that was already idle".
struct ThreadStatusSnapshot: Equatable {
    var threadID: String?
    var status: ThreadStatus?

    init(threadID: String? = nil, status: ThreadStatus? = nil) {
        self.threadID = threadID
        self.status = status
    }
}

/// Which tap, if any, the *watched* thread's status transition earns.
///
/// macOS banners are deliberately suppressed for the thread the user is
/// already looking at (`AgentNotificationPolicy`), which leaves the most
/// common case — waiting on the conversation in front of you — with no
/// ambient signal at all. This is that signal, and only that: threads in the
/// sidebar keep using notifications.
enum ThreadStatusHaptics {
    static func event(from old: ThreadStatusSnapshot, to new: ThreadStatusSnapshot) -> HapticEvent? {
        guard let oldStatus = old.status, let newStatus = new.status,
            old.threadID != nil, old.threadID == new.threadID,
            oldStatus != newStatus
        else { return nil }
        switch newStatus {
        case .waitingApproval, .waitingInput:
            return .decision
        case .error:
            return .failure
        case .idle, .done, .settled, .readyToMerge:
            // Only the run *ending* is an event; idle → settled housekeeping
            // is not something the user asked to feel.
            return oldStatus.isSettled ? nil : .success
        default:
            return nil
        }
    }
}

extension View {
    /// Plays `event` whenever `trigger` changes — the macOS stand-in for
    /// `.sensoryFeedback(_:trigger:)`, which is iOS/watchOS only.
    @MainActor
    func haptic<V: Equatable>(_ event: HapticEvent, trigger: V) -> some View {
        onChange(of: trigger) { _, _ in Haptics.play(event) }
    }

    /// Plays `event` when `trigger` changes and `shouldPlay` accepts the
    /// transition — for state that also changes for reasons the user didn't
    /// cause (async status, programmatic selection).
    @MainActor
    func haptic<V: Equatable>(
        _ event: HapticEvent, trigger: V, when shouldPlay: @escaping (V, V) -> Bool
    ) -> some View {
        onChange(of: trigger) { old, new in
            guard shouldPlay(old, new) else { return }
            Haptics.play(event)
        }
    }

    /// One tap on press-down (never on release, so a cancelled press doesn't
    /// double-tap). For styles that carry their own visual press treatment.
    @MainActor
    func hapticPress(_ isPressed: Bool, event: HapticEvent = .selection) -> some View {
        onChange(of: isPressed) { _, pressed in
            guard pressed else { return }
            Haptics.play(event)
        }
    }

    /// The app's standard press treatment for a custom `ButtonStyle`: a scale
    /// dip on the feedback curve plus the press-down tap.
    @MainActor
    func pressFeedback(
        _ isPressed: Bool, event: HapticEvent = .selection, scale: CGFloat = 0.97
    ) -> some View {
        scaleEffect(isPressed && !Motion.reduceMotion ? scale : 1)
            .animation(Motion.feedback, value: isPressed)
            .hapticPress(isPressed, event: event)
    }
}
