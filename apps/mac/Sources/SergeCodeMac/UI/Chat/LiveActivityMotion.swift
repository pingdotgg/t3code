import SwiftUI

// Decorative state for live activity rows. Keep these effects static while a
// row is running: a busy workspace can show dozens of live rows at once, so a
// display clock or phase animator here multiplies into persistent AttributeGraph
// work. More importantly, macOS 27 can dereference a stale Swift executor from
// `phaseAnimator` while one of those rows is removed during layout. One-shot
// state transitions remain animated by each row's existing ambient animation.

// MARK: - Shimmer border

private struct ShimmerBorderModifier: ViewModifier {
    let color: Color
    let isActive: Bool
    let cornerRadius: CGFloat

    func body(content: Content) -> some View {
        content.overlay {
            if isActive {
                ZStack {
                    if !Motion.reduceMotion {
                        RoundedRectangle(cornerRadius: cornerRadius)
                            .strokeBorder(color.opacity(0.22), lineWidth: 3)
                            .blur(radius: 3)
                    }
                    RoundedRectangle(cornerRadius: cornerRadius)
                        .strokeBorder(
                            color.opacity(Motion.reduceMotion ? 0.45 : 0.72),
                            lineWidth: Motion.reduceMotion ? 1 : 1.5)
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

    func body(content: Content) -> some View {
        content.opacity(isActive && !Motion.reduceMotion ? 0.78 : 1)
    }
}

extension View {
    /// Static tint stroke + soft glow marking a card as live.
    /// Reduce Motion keeps the stroke and drops the blur.
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

    /// Static opacity cue while a row is live. The surrounding row animates
    /// state changes once; no per-row animation remains mounted while work runs.
    func pulseGlow(isActive: Bool) -> some View {
        modifier(PulseGlowModifier(isActive: isActive))
    }
}
