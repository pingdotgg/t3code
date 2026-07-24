import SwiftUI

// Decorative, ongoing motion for live activity rows. Everything here is
// gated on `Motion.reduceMotion` and renders nothing while inactive, so
// settled rows pay no animation cost — only the handful of running rows on
// screen ever host a `TimelineView` or phase animator. None of these
// modifiers affect layout: they are overlays and render transforms, which is
// what keeps them safe to run inside the streaming timeline (the same rule
// `Entrance` follows — sibling layout is never re-measured).

// MARK: - Shimmer border

private struct ShimmerBorderModifier: ViewModifier {
    let color: Color
    let isActive: Bool
    let cornerRadius: CGFloat

    func body(content: Content) -> some View {
        content.overlay {
            if isActive {
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
        }
    }
}

// MARK: - Success ripple

private struct SuccessRippleModifier: ViewModifier {
    /// True while the row is in its just-succeeded state. The ripple fires
    /// only on the false→true edge, so rows hydrated already-complete (a
    /// restored transcript) never replay a celebration they didn't witness.
    let fire: Bool
    let cornerRadius: CGFloat

    @UIState private var progress: Double = 1
    @UIState private var consumed = false

    func body(content: Content) -> some View {
        content.overlay {
            if progress < 1 {
                RoundedRectangle(cornerRadius: cornerRadius)
                    .strokeBorder(
                        AlpineTheme.statusSuccess.opacity(1 - progress),
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
        if isActive && !Motion.reduceMotion {
            content.phaseAnimator([0.55, 1.0]) { view, opacity in
                view.opacity(opacity)
            }
        } else {
            content
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
        modifier(SuccessRippleModifier(fire: fire, cornerRadius: cornerRadius))
    }

    /// Gentle breathing opacity while a row is live.
    func pulseGlow(isActive: Bool) -> some View {
        modifier(PulseGlowModifier(isActive: isActive))
    }
}
