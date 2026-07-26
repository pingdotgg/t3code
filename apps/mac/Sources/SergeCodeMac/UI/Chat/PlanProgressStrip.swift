import SwiftUI

/// The agent's live in-turn todo list (`turn.plan.updated` activities),
/// docked above the composer as a compact, right-anchored card so progress
/// stays visible while the agent works without spanning the full composer
/// column (it lines up with the Unsplash credit pill beneath it — see
/// ChatScreen). Collapsed it shows the current step, a completed/total
/// badge, and a slim progress rail; expanded it lists every step on an
/// opaque reading plate inside the glass frame.
struct PlanProgressStrip: View {
    let model: AppModel

    @UIState private var isExpanded = false

    private var progress: PlanProgress? {
        guard let threadID = model.selectedThreadID else { return nil }
        return model.threadState(threadID)?.planProgress
    }

    var body: some View {
        if let progress, !progress.steps.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                headerButton(progress)
                progressRail(progress)
                    .padding(.top, 8)
                if isExpanded {
                    stepList(progress)
                        .transition(Motion.unfold)
                }
            }
            .padding(10)
            .glassEffect(.regular, in: .rect(cornerRadius: AlpineTheme.Corners.card))
            .onReceive(NotificationCenter.default.publisher(for: .uiProbeToggleSection)) { note in
                guard note.object as? String == "plan" else { return }
                withDeferredAnimation(Motion.feedback) {
                    isExpanded.toggle()
                }
            }
            .animation(Motion.structure, value: isExpanded)
            // Live todo updates stream in from the agent; row-local content
            // transitions handle them without reanimating the whole strip.
            .transition(Motion.banner)
        }
    }

    // MARK: - Header

    private func headerButton(_ progress: PlanProgress) -> some View {
        let completed = progress.steps.filter { $0.status == .completed }.count
        return Button {
            // No explicit animation: the container's structure-curve
            // `.animation(value: isExpanded)` owns the expand/collapse.
            isExpanded.toggle()
        } label: {
            HStack(spacing: 8) {
                iconTile
                Text("Plan")
                    .font(.callout.weight(.semibold))
                countBadge(completed: completed, total: progress.steps.count)
                if !isExpanded, let current = currentStep(progress) {
                    Text(current.title)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .contentTransition(
                            Motion.reduceMotion ? .identity : .opacity)
                        .animation(Motion.ambient, value: current.title)
                        .transition(Motion.rise)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(isExpanded ? "Collapse plan" : "Expand plan")
        .accessibilityIdentifier("plan-strip-toggle")
    }

    /// The checklist glyph on a soft accent tile — the same pastel-tile
    /// identity PlanCard wears in the timeline, so the strip reads as the
    /// same feature before a word is read.
    private var iconTile: some View {
        Image(systemName: "checklist")
            .font(.callout.weight(.semibold))
            .foregroundStyle(AlpineTheme.accent)
            .frame(width: 26, height: 26)
            .background(
                AlpineTheme.accent.opacity(0.16),
                in: RoundedRectangle(cornerRadius: AlpineTheme.Corners.control, style: .continuous))
    }

    /// Completed/total as a small capsule that flips to the success tint
    /// once every step lands, mirroring PlanCard's implemented badge.
    private func countBadge(completed: Int, total: Int) -> some View {
        let done = completed == total
        let tint = done ? AlpineTheme.statusSuccess : AlpineTheme.accent
        return Text("\(completed)/\(total)")
            .font(.caption2.monospacedDigit().weight(.medium))
            .foregroundStyle(done ? tint : .primary)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(tint.opacity(0.15), in: Capsule())
            .contentTransition(
                Motion.reduceMotion ? .identity : .numericText())
            .animation(Motion.ambient, value: completed)
    }

    /// Hairline progress rail under the header: at-a-glance completion even
    /// while collapsed, re-tinting to success green when the plan lands.
    private func progressRail(_ progress: PlanProgress) -> some View {
        let completed = progress.steps.filter { $0.status == .completed }.count
        let fraction = Double(completed) / Double(progress.steps.count)
        let done = completed == progress.steps.count
        return Capsule()
            .fill(.secondary.opacity(0.2))
            .overlay(alignment: .leading) {
                GeometryReader { proxy in
                    Capsule()
                        .fill(done ? AlpineTheme.statusSuccess : AlpineTheme.accent)
                        .frame(width: proxy.size.width * fraction)
                }
            }
            .frame(height: 3)
            .accessibilityLabel("Plan progress")
            .accessibilityValue("\(completed) of \(progress.steps.count) steps completed")
            .animation(Motion.ambient, value: fraction)
    }

    /// The step to surface while collapsed: the one in progress, else the
    /// first pending one.
    private func currentStep(_ progress: PlanProgress) -> PlanStep? {
        progress.steps.first { $0.status == .inProgress }
            ?? progress.steps.first { $0.status == .pending }
    }

    // MARK: - Steps

    @ViewBuilder
    private func stepList(_ progress: PlanProgress) -> some View {
        // Hug short plans; only long ones get a fixed-height scroller.
        // (A `maxHeight` frame is greedy up to its cap, so it can't hug —
        // branch on the step count instead.)
        Group {
            if progress.steps.count <= 7 {
                stepRows(progress)
            } else {
                ScrollView {
                    stepRows(progress)
                }
                .frame(height: 200)
            }
        }
        // Reading surface inside the glass frame stays opaque, matching
        // PlanCard's markdown body.
        .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
        .padding(.top, 8)
    }

    private func stepRows(_ progress: PlanProgress) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let explanation = progress.explanation, !explanation.isEmpty {
                Text(explanation)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            // Batch arrivals stagger through the entrance policy (clamped
            // 28ms step) instead of rising all at once; the one-shot latch
            // keeps live status updates from replaying the entrance.
            ForEach(Array(progress.steps.enumerated()), id: \.element.id) { index, step in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    statusIcon(step.status)
                    Text(step.title)
                        .font(.callout)
                        .strikethrough(step.status == .completed, color: .secondary)
                        .foregroundStyle(step.status == .completed ? .secondary : .primary)
                }
                .entrance(.row, index: index)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
    }

    /// One `Image` so pending → in-progress → completed morphs via
    /// `.contentTransition` rather than swapping glyphs.
    private func statusIcon(_ status: PlanStepStatus) -> some View {
        Image(systemName: iconName(status))
            .font(.callout)
            .foregroundStyle(iconTint(status))
            .contentTransition(
                Motion.reduceMotion ? .identity : .symbolEffect(.replace))
    }

    private func iconName(_ status: PlanStepStatus) -> String {
        switch status {
        case .pending: "circle"
        case .inProgress: "circle.dotted"
        case .completed: "checkmark.circle.fill"
        }
    }

    private func iconTint(_ status: PlanStepStatus) -> Color {
        switch status {
        case .pending: .secondary
        case .inProgress: AlpineTheme.accent
        case .completed: AlpineTheme.statusSuccess
        }
    }
}
