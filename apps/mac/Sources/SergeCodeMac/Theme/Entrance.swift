import SwiftUI

// Arrival motion. `Motion` says how things move; this says that everything
// which appears must move at all (SER-144). The two compose: entrance picks a
// role, the role picks an existing `Motion` curve.
//
// Entrance is deliberately built on the view's own local state rather than on a
// SwiftUI `.transition`. A transition only plays when the *parent* animates the
// insertion, and animating the parent is exactly what `ChatTimelineScrollView`
// suppresses to stop the `LazyVStack` re-measuring realized rows mid-stream.
// Local opacity/offset animates a view in without touching sibling layout, so
// hydration can animate while the streaming carve-outs stay intact.
//
// One caveat: the timeline's suppressor works by clearing
// `transaction.animation` on the LazyVStack, which flattens *every* descendant
// animation it doesn't recognize — including the entrance's own. The entrance
// transaction is therefore marked (`isEntranceAnimation`) so the suppressor
// whitelists it, the same way user-initiated disclosures are whitelisted.

// MARK: - Environment

private enum EntranceSuppressedKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// Set by containers that must not animate arrival right now — a timeline
    /// mid-stream, a collection mid-regroup, or any subtree past its entrance
    /// window. Suppressed content still renders immediately; it just renders
    /// settled. Nothing is ever gated behind an animation that will not run.
    var entranceSuppressed: Bool {
        get { self[EntranceSuppressedKey.self] }
        set { self[EntranceSuppressedKey.self] = newValue }
    }
}

// MARK: - Transaction key

private enum EntranceAnimationKey: TransactionKey {
    static let defaultValue = false
}

extension Transaction {
    /// Marks a state change as an entrance arrival. The streaming chat
    /// timeline clears `transaction.animation` on its LazyVStack to stop
    /// mid-run layout churn, and that suppressor flattens every descendant
    /// animation it doesn't recognize — an unmarked entrance flipped its
    /// state instantly, so arriving rows popped in instead of animating.
    /// Entrance only animates render-time transforms (opacity/scale/offset),
    /// never layout, so the suppressor whitelists marked transactions just
    /// like `isIntentionalDisclosure`.
    var isEntranceAnimation: Bool {
        get { self[EntranceAnimationKey.self] }
        set { self[EntranceAnimationKey.self] = newValue }
    }
}

// MARK: - Role curves

extension EntranceRole {
    /// Roles reuse the existing motion vocabulary rather than adding curves.
    @MainActor var animation: Animation {
        switch self {
        case .row: Motion.reveal
        case .card, .pane: Motion.structure
        case .control: Motion.feedback
        case .hero: Motion.delight
        }
    }
}

// MARK: - Entrance

private struct EntranceModifier: ViewModifier {
    let role: EntranceRole
    let index: Int

    @Environment(\.entranceSuppressed) private var suppressed
    @UIState private var hasEntered = false

    func body(content: Content) -> some View {
        let policy = EntrancePolicy(reduceMotion: Motion.reduceMotion)
        let settled = hasEntered || suppressed

        content
            .opacity(settled ? 1 : policy.initialOpacity)
            .scaleEffect(settled ? 1 : policy.initialScale(for: role))
            .offset(y: settled ? 0 : policy.offset(for: role))
            .onAppear {
                guard policy.shouldPlay(alreadyPlayed: hasEntered, suppressed: suppressed)
                else {
                    // Already visible. Latch so lifting suppression later does
                    // not make settled content animate as if it were new.
                    hasEntered = true
                    return
                }
                // Marked so the streaming timeline's animation suppressor lets
                // this through — unmarked, `hasEntered` flipped instantly and
                // arriving rows popped in mid-run. See `isEntranceAnimation`.
                var transaction = Transaction(
                    animation: role.animation.delay(policy.delay(forIndex: index)))
                transaction.isEntranceAnimation = true
                withTransaction(transaction) {
                    hasEntered = true
                }
            }
    }
}

extension View {
    /// Animates this view's arrival the first time it appears. `index` is its
    /// position among siblings arriving together; the stagger it produces is
    /// clamped by `EntrancePolicy` so long lists cannot ripple.
    func entrance(_ role: EntranceRole, index: Int = 0) -> some View {
        modifier(EntranceModifier(role: role, index: index))
    }
}

// MARK: - Entrance window

private struct EntranceWindowModifier<Key: Equatable & Sendable>: ViewModifier {
    let key: Key
    let duration: Double

    @Environment(\.entranceSuppressed) private var inheritedSuppression
    @UIState private var isOpen = true

    func body(content: Content) -> some View {
        content
            // An outer suppression always wins: a streaming timeline stays
            // suppressed even while its own window is nominally open.
            .environment(\.entranceSuppressed, inheritedSuppression || !isOpen)
            .task(id: key) {
                isOpen = true
                try? await Task.sleep(for: .seconds(duration))
                isOpen = false
            }
    }
}

extension View {
    /// Lets descendants animate their arrival for a brief window after `key`
    /// changes, then suppresses entrance for the rest of this container's life.
    ///
    /// Lazy containers need this. A `LazyVStack` realizes rows as they scroll
    /// into view, so without a window a row 200 items down would fade in under
    /// the user's pointer on every scroll. Entrance is for content *arriving*,
    /// not for content being revealed by scrolling.
    ///
    /// The default duration covers the clamped stagger plus the slowest role
    /// curve, so the last staggered sibling still lands inside the window.
    func entranceWindow<Key: Equatable & Sendable>(
        resetOn key: Key,
        duration: Double = 0.5
    ) -> some View {
        modifier(EntranceWindowModifier(key: key, duration: duration))
    }

    /// Suppresses arrival animation for this subtree while `suppressed` is true.
    func entranceSuppressed(_ suppressed: Bool) -> some View {
        transformEnvironment(\.entranceSuppressed) { $0 = $0 || suppressed }
    }
}
