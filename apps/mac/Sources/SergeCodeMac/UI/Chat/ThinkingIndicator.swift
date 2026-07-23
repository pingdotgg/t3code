import SwiftUI

/// Ephemeral parent-agent "Thinking…" cue for silent model reasoning.
///
/// Distinct from subagent "Working..." rows and generic ProgressView loading:
/// soft meadow/lavender dots, italic label, no busy spinner. One instance is
/// pinned to the timeline tail so long silent periods never flood the transcript.
struct ThinkingIndicator: View {
    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            ThinkingDots()
                .frame(width: TranscriptMetrics.iconColumn, alignment: .center)

            HStack(spacing: 0) {
                Text("Thinking")
                    .font(.callout)
                    .italic()
                    .foregroundStyle(.secondary)
                ThinkingEllipsis()
                    .font(.callout)
                    .italic()
                    .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Thinking")

            Spacer(minLength: 0)
        }
        .padding(.leading, TranscriptMetrics.cardPadH)
        .padding(.vertical, 2)
        .accessibilityAddTraits(.updatesFrequently)
    }
}

/// Three soft pastel dots that breathe in sequence while the model reasons.
/// Under Reduce Motion the dots stay fully opaque with no pulse.
private struct ThinkingDots: View {
    var body: some View {
        TimelineView(
            .animation(
                minimumInterval: Motion.reduceMotion ? nil : 0.35,
                paused: Motion.reduceMotion)
        ) { context in
            let phase = Motion.reduceMotion
                ? 0
                : Int(context.date.timeIntervalSinceReferenceDate / 0.35) % 3
            HStack(spacing: 3) {
                ForEach(0..<3, id: \.self) { index in
                    Circle()
                        .fill(dotColor(index: index))
                        .frame(width: 5, height: 5)
                        .opacity(Motion.reduceMotion ? 0.85 : (index == phase ? 1 : 0.35))
                        .scaleEffect(Motion.reduceMotion ? 1 : (index == phase ? 1.15 : 0.9))
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

/// Animated "…" after Thinking. Reduce Motion renders a static ellipsis.
private struct ThinkingEllipsis: View {
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
