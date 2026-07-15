import SwiftUI

/// The agent's live in-turn todo list (`turn.plan.updated` activities),
/// docked above the composer as a collapsible strip so progress stays
/// visible while the agent works. Collapsed it shows the current step and
/// a completed/total count; expanded it lists every step.
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
            withAnimation(Motion.feedback) { isExpanded.toggle() }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "checklist")
                    .font(.callout)
                    .foregroundStyle(AlpineTheme.accent)
                Text("Plan")
                    .font(.callout.weight(.semibold))
                Text("\(completed)/\(progress.steps.count)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .contentTransition(.numericText())
                if !isExpanded, let current = currentStep(progress) {
                    Text(current.title)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .transition(.opacity)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(isExpanded ? "Collapse plan" : "Expand plan")
        .accessibilityIdentifier("plan-strip-toggle")
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
        VStack(alignment: .leading, spacing: 6) {
            if let explanation = progress.explanation, !explanation.isEmpty {
                Text(explanation)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ForEach(progress.steps) { step in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    statusIcon(step.status)
                    Text(step.title)
                        .font(.callout)
                        .strikethrough(step.status == .completed, color: .secondary)
                        .foregroundStyle(step.status == .completed ? .secondary : .primary)
                }
                .transition(Motion.rise)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
    }

    /// One `Image` so pending → in-progress → completed morphs via
    /// `.contentTransition` rather than swapping glyphs.
    private func statusIcon(_ status: PlanStepStatus) -> some View {
        Image(systemName: iconName(status))
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
        case .completed: AlpineTheme.meadow
        }
    }
}
