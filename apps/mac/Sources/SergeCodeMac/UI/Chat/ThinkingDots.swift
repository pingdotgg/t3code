import SwiftUI

// The quiet half of the live-turn indicator: soft meadow/lavender dots and an
// animated ellipsis, with no busy spinner. `AgentActivityDock` renders these
// instead of its aurora orb under Reduce Motion and when playful motion is
// switched off, so the calm presentation the app shipped with survives both
// opt-outs unchanged.

/// Three soft pastel dots that breathe in sequence while the model works.
/// Under Reduce Motion the dots stay fully opaque with no pulse.
struct ThinkingDots: View {
    var body: some View {
        TimelineView(
            .animation(
                minimumInterval: Motion.reduceMotion ? nil : 0.35,
                paused: Motion.reduceMotion)
        ) { context in
            let phase = Motion.reduceMotion
                ? 0
                : Int(context.date.timeIntervalSinceReferenceDate / 0.35) % 3
            HStack(spacing: 4) {
                ForEach(0..<3, id: \.self) { index in
                    Circle()
                        .fill(dotColor(index: index))
                        .frame(width: 6, height: 6)
                        .shadow(
                            color: Motion.reduceMotion || index != phase
                                ? .clear : dotColor(index: index).opacity(0.6),
                            radius: 3)
                        .opacity(Motion.reduceMotion ? 0.85 : (index == phase ? 1 : 0.35))
                        .scaleEffect(Motion.reduceMotion ? 1 : (index == phase ? 1.2 : 0.9))
                }
            }
            .animation(Motion.reduceMotion ? nil : Motion.ambient, value: phase)
        }
    }

    private func dotColor(index: Int) -> Color {
        switch index {
        case 0: AlpineTheme.meadow.opacity(0.95)
        case 1: AlpineTheme.accent.opacity(0.95)
        default: AlpineTheme.lavender.opacity(0.95)
        }
    }
}

/// Animated "…" trailing the status label. Reduce Motion renders a static
/// ellipsis. Fixed width so the label beside it never reflows as dots land.
struct ThinkingEllipsis: View {
    var body: some View {
        if Motion.reduceMotion {
            Text("…")
        } else {
            TimelineView(.animation(minimumInterval: 0.45, paused: false)) { context in
                let count = Int(context.date.timeIntervalSinceReferenceDate / 0.45) % 4
                Text(String(repeating: ".", count: count))
                    .frame(width: 14, alignment: .leading)
                    .monospacedDigit()
            }
        }
    }
}
