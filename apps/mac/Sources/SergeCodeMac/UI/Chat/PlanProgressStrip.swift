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
            .glassEffect(.regular, in: .rect(cornerRadius: 16))
            .onReceive(NotificationCenter.default.publisher(for: .uiProbeToggleSection)) { note in
                guard note.object as? String == "plan" else { return }
                // Deferred one runloop turn: UIProbe may post this right after a
                // cacheDisplay snapshot forced layout; a synchronous flip mid
                // display cycle re-enters AppKit's layout-feedback-loop guard
                // (see ContentView inspector toggle).
                DispatchQueue.main.async {
                    withAnimation(Motion.snap) { isExpanded.toggle() }
                }
            }
            .animation(Motion.settle, value: isExpanded)
            // Live todo updates stream in from the agent: the count ticks,
            // the current-step label swaps, expanded rows morph their icons.
            .animation(Motion.settle, value: progress.steps)
            .transition(Motion.bannerDrop)
        }
    }

    // MARK: - Header

    private func headerButton(_ progress: PlanProgress) -> some View {
        let completed = progress.steps.filter { $0.status == .completed }.count
        return Button {
            withAnimation(Motion.snap) { isExpanded.toggle() }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "checklist")
                    .font(.callout)
                    .foregroundStyle(Color.accentColor)
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
            .symbolEffect(.pulse, isActive: status == .inProgress)
            .foregroundStyle(iconTint(status))
            .contentTransition(.symbolEffect(.replace))
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
        case .inProgress: .accentColor
        case .completed: .green
        }
    }
}
