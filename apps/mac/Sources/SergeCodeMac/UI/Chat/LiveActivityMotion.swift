import SwiftUI

// Decorative, ongoing motion for live activity rows. Everything here is
// gated on `Motion.reduceMotion` and renders nothing while inactive, so
// settled rows pay no animation cost — only the handful of running rows on
// screen ever host a `TimelineView` or a live multi-phase animator (the
// pulse glow stays mounted when settled, parked on its static 1.0 phase).
// None of these modifiers affect layout: they are overlays and render
// transforms, which is what keeps them safe to run inside the streaming
// timeline (the same rule `Entrance` follows — sibling layout is never
// re-measured).

// MARK: - Shimmer border

private struct ShimmerBorderModifier: ViewModifier {
    let color: Color
    let isActive: Bool
    let cornerRadius: CGFloat

    func body(content: Content) -> some View {
        content.overlay {
            if isActive {
                Group {
                    if Motion.reduceMotion {
                        // No movement, but the running state must stay visible.
                        RoundedRectangle(cornerRadius: cornerRadius)
                            .strokeBorder(color.opacity(0.45), lineWidth: 1)
                    } else {
                        TimelineView(.animation(minimumInterval: 1.0 / 30)) { context in
                            let angle = Angle.degrees(
                                context.date.timeIntervalSinceReferenceDate * 120)
                            ZStack {
                                RoundedRectangle(cornerRadius: cornerRadius)
                                    .strokeBorder(color.opacity(0.25), lineWidth: 3)
                                    .blur(radius: 3)
                                RoundedRectangle(cornerRadius: cornerRadius)
                                    .strokeBorder(
                                        AngularGradient(
                                            colors: [
                                                color.opacity(0.05),
                                                color.opacity(0.8),
                                                color.opacity(0.05),
                                            ],
                                            center: .center,
                                            startAngle: angle,
                                            endAngle: angle + .degrees(360)),
                                        lineWidth: 1.5)
                            }
                        }
                    }
                }
                // Fade out on completion instead of hard-cutting; rides the
                // row's `.animation(Motion.ambient, value: displayState)`.
                .transition(.opacity)
            }
        }
    }
}

// MARK: - Outcome ripple

private struct OutcomeRippleModifier: ViewModifier {
    /// True while the row is in its just-settled state. The ripple fires
    /// only on the false→true edge, so rows hydrated already-complete (a
    /// restored transcript) never replay a celebration they didn't witness.
    let fire: Bool
    let cornerRadius: CGFloat
    let color: Color

    @UIState private var progress: Double = 1
    @UIState private var consumed = false

    func body(content: Content) -> some View {
        content.overlay {
            if progress < 1 {
                RoundedRectangle(cornerRadius: cornerRadius)
                    .strokeBorder(
                        color.opacity(1 - progress),
                        lineWidth: 2)
                    .scaleEffect(0.7 + progress * 1.1)
                    .opacity(1 - progress)
                    .allowsHitTesting(false)
            }
        }
        .onChange(of: fire) { _, fired in
            guard fired, !consumed else { return }
            consumed = true
            guard Motion.profile.allowsDecorativeEffects else { return }
            progress = 0
            withAnimation(Motion.burst) {
                progress = 1
            }
        }
    }
}

// MARK: - Pulse glow

private struct PulseGlowModifier: ViewModifier {
    let isActive: Bool

    /// Latched, never cleared. Once a row has pulsed, the animator stays
    /// mounted so deactivation eases from the current dip back to 1.0 —
    /// structurally swapping back to plain `content` made a chip caught
    /// mid-dip jump in opacity. A row that has *never* pulsed has no dip to
    /// preserve, so it renders as plain content and mounts no animator at
    /// all: a restored transcript and the settled body of a long tool burst
    /// are almost entirely such rows, and each one used to host a
    /// `phaseAnimator` parked forever on a single static phase.
    @UIState private var hasPulsed = false

    func body(content: Content) -> some View {
        let animates = !Motion.reduceMotion && (isActive || hasPulsed)
        return Group {
            if animates {
                content.phaseAnimator(isActive ? [0.55, 1.0] : [1.0]) { view, opacity in
                    view.opacity(opacity)
                }
            } else {
                content
            }
        }
        .onChange(of: isActive, initial: true) { _, active in
            guard active, !hasPulsed else { return }
            hasPulsed = true
        }
    }
}

extension View {
    /// Animated rotating-gradient stroke + soft glow marking a card as live.
    /// Reduce Motion falls back to a static tint stroke so the running state
    /// is still readable.
    func shimmerBorder(color: Color, isActive: Bool, cornerRadius: CGFloat) -> some View {
        modifier(ShimmerBorderModifier(
            color: color, isActive: isActive, cornerRadius: cornerRadius))
    }

    /// One-shot expanding ring when `fire` flips true (running → succeeded).
    func successRipple(fire: Bool, cornerRadius: CGFloat) -> some View {
        modifier(OutcomeRippleModifier(
            fire: fire, cornerRadius: cornerRadius, color: AlpineTheme.statusSuccess))
    }

    /// One-shot expanding ring when `fire` flips true (running → failed).
    /// Same timing as the success ripple; only the ring color differs.
    func failureRipple(fire: Bool, cornerRadius: CGFloat) -> some View {
        modifier(OutcomeRippleModifier(
            fire: fire, cornerRadius: cornerRadius, color: .red))
    }

    /// Gentle breathing opacity while a row is live.
    func pulseGlow(isActive: Bool) -> some View {
        modifier(PulseGlowModifier(isActive: isActive))
    }
}
