import SwiftUI

/// Whether the plan rail takes part in the credit row above the composer, and
/// on what terms. Pulled out of the view so the layout rule is testable: the
/// difference between the two cases is invisible in a screenshot of a chat
/// that has a scenery photo, which is every chat with an Unsplash key set.
enum PlanRailPolicy {
    /// - With a photo the row is on screen for the credit anyway, so the rail
    ///   mounts for the whole live turn and holds its height while the plan
    ///   hydrates: the credit pill cannot shift when steps land.
    /// - With no photo the row exists only for the rail, so it waits for real
    ///   steps. Reserving height there would be empty space pushing the
    ///   composer down for every run, including the many that never plan.
    static func showsRail(isLiveTurn: Bool, hasPhoto: Bool, hasSteps: Bool) -> Bool {
        guard isLiveTurn else { return false }
        return hasPhoto || hasSteps
    }
}

/// The agent's live in-turn todo list (`turn.plan.updated` activities),
/// docked above the composer as a single-row progress rail that shares its
/// row with the Unsplash credit pill (see ChatScreen): the rail takes all the
/// free width to the left of the credit, so progress reads as one continuous
/// bar rather than a card stacked on top of the attribution.
///
/// Collapsed, the rail *is* the progress bar — the fill grows behind the
/// current step, step boundaries show as ticks, and a light sweep travels the
/// filled region while the run is live. Expanded, the full step list unfolds
/// upward on an opaque reading plate.
///
/// The plan lands after the turn starts and most turns never send one at all,
/// so what the strip does with an empty plan depends on whether the row it
/// lives in exists for another reason: with a credit pill beside it
/// (`reservesSlotWhileEmpty`) it holds the rail's height so the pill cannot
/// move when steps land; with no pill there is nothing to keep aligned, so it
/// draws nothing and ChatScreen keeps the row out of the layout entirely.
struct PlanProgressStrip: View {
    let model: AppModel

    /// Whether an empty plan should still hold the rail's height. True only
    /// when the row is already on screen for the scenery credit — reserving
    /// space in an otherwise empty row would push the composer down for every
    /// live turn, plan or not.
    var reservesSlotWhileEmpty: Bool = false

    @UIState private var isExpanded = false

    /// Rail height: matches the Unsplash credit pill's optical height so the
    /// two sit on one baseline.
    private static let railHeight: CGFloat = 24

    private var progress: PlanProgress? {
        guard let threadID = model.selectedThreadID else { return nil }
        return model.threadState(threadID)?.planProgress
    }

    /// Whether the selected thread has a turn in flight — the same predicate
    /// ChatScreen mounts the row with, so the reserved slot covers exactly
    /// the window between the run starting and the plan arriving.
    private var isLive: Bool {
        model.selectedThread?.status.isLiveTurn ?? false
    }

    var body: some View {
        if let progress, !progress.steps.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                if isExpanded {
                    stepList(progress)
                        .transition(Motion.unfold)
                }
                railButton(progress)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
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
        } else if isLive, reservesSlotWhileEmpty {
            reservedSlot
        }
    }

    /// Nothing to draw yet — a placeholder rail would put permanent chrome on
    /// screen for every turn that never plans. Hold the rail's height
    /// instead, so the credit row keeps one size for the whole turn and the
    /// real rail fades in beside a pill that never moved.
    private var reservedSlot: some View {
        Color.clear
            .frame(maxWidth: .infinity)
            .frame(height: Self.railHeight)
            .accessibilityHidden(true)
    }

    // MARK: - Rail

    private func railButton(_ progress: PlanProgress) -> some View {
        Button {
            // No explicit animation: the container's structure-curve
            // `.animation(value: isExpanded)` owns the expand/collapse.
            isExpanded.toggle()
        } label: {
            rail(progress)
        }
        .buttonStyle(.plain)
        .help(isExpanded ? "Collapse plan" : "Expand plan")
        .accessibilityIdentifier("plan-strip-toggle")
    }

    private func rail(_ progress: PlanProgress) -> some View {
        let completed = progress.steps.filter { $0.status == .completed }.count
        let total = progress.steps.count
        let done = completed == total
        let fraction = Double(completed) / Double(total)
        return HStack(spacing: 7) {
            railIcon(done: done)
            railTitle(progress, done: done)
            Spacer(minLength: 8)
            countBadge(completed: completed, total: total, done: done)
            Image(systemName: "chevron.up")
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(.white.opacity(0.55))
                .rotationEffect(.degrees(isExpanded ? 180 : 0))
        }
        .padding(.horizontal, 8)
        .frame(height: Self.railHeight)
        .frame(maxWidth: .infinity)
        .background { track(fraction: fraction, total: total, done: done) }
        .glassEffect(.regular, in: Capsule())
        // One-shot ring when the last step lands — the same celebration the
        // timeline's activity rows use.
        .successRipple(fire: done, cornerRadius: Self.railHeight / 2)
        .contentShape(Capsule())
        // The rail sits directly on photography, so its compact labels stay
        // in the same always-dark foreground treatment as New Session.
        .sceneryChrome()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Plan progress")
        .accessibilityValue("\(completed) of \(total) steps completed")
        .accessibilityHint(isExpanded ? "Collapse plan" : "Expand plan")
    }

    private func railIcon(done: Bool) -> some View {
        Image(systemName: done ? "checkmark.circle.fill" : "checklist")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(done ? AlpineTheme.statusSuccess : AlpineTheme.accent)
            .contentTransition(
                Motion.reduceMotion ? .identity : .symbolEffect(.replace))
            // Only the glyph breathes while the plan is live; the bar itself
            // must not change opacity behind text.
            .pulseGlow(isActive: !done)
    }

    private func railTitle(_ progress: PlanProgress, done: Bool) -> some View {
        let title = done ? "Plan complete" : (currentStep(progress)?.title ?? "Plan")
        return Text(title)
            .font(.caption.weight(.medium))
            .foregroundStyle(.white.opacity(0.92))
            .lineLimit(1)
            .truncationMode(.tail)
            .contentTransition(Motion.reduceMotion ? .identity : .opacity)
            .animation(Motion.ambient, value: title)
    }

    /// Completed/total as a small capsule that flips to the success tint once
    /// every step lands, mirroring PlanCard's implemented badge.
    private func countBadge(completed: Int, total: Int, done: Bool) -> some View {
        let tint = done ? AlpineTheme.statusSuccess : AlpineTheme.accent
        return Text("\(completed)/\(total)")
            .font(.system(size: 9, weight: .semibold).monospacedDigit())
            .foregroundStyle(done ? tint : .white.opacity(0.9))
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(tint.opacity(0.22), in: Capsule())
            .contentTransition(
                Motion.reduceMotion ? .identity : .numericText())
            .animation(Motion.ambient, value: completed)
    }

    // MARK: - Bar internals

    /// Track, fill, step ticks. Sized by the rail's own frame, so the bar is
    /// exactly as wide as the space left of the credit pill.
    private func track(fraction: Double, total: Int, done: Bool) -> some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            ZStack(alignment: .leading) {
                fill(width: max(0, width * fraction), height: proxy.size.height, done: done)
                ticks(total: total, width: width, fraction: fraction)
            }
            // A completed step springs the fill forward with a little bounce;
            // that overshoot is the whole point of the moment.
            .animation(Motion.delight, value: fraction)
        }
    }

    private func fill(width: CGFloat, height: CGFloat, done: Bool) -> some View {
        let tint = done ? AlpineTheme.statusSuccess : AlpineTheme.accent
        return Capsule()
            .fill(
                LinearGradient(
                    colors: [tint.opacity(0.30), tint.opacity(0.62)],
                    startPoint: .leading, endPoint: .trailing)
            )
            .overlay(alignment: .trailing) { fillHead(tint: tint, visible: width > 2) }
            .overlay { sweep(width: width, done: done) }
            .frame(width: width, height: height)
            .clipShape(Capsule())
    }

    /// Bright leading edge of the fill: the "playhead" that makes the bar read
    /// as moving even between step completions.
    private func fillHead(tint: Color, visible: Bool) -> some View {
        Rectangle()
            .fill(tint.opacity(visible ? 0.95 : 0))
            .frame(width: 2)
            .blur(radius: 1.5)
            .shadow(color: tint.opacity(0.8), radius: 4)
    }

    /// Light band travelling across the filled region while the plan is still
    /// running. Decorative: Reduce Motion (and completion) render nothing.
    @ViewBuilder
    private func sweep(width: CGFloat, done: Bool) -> some View {
        if !done, width > 8, Motion.profile.allowsDecorativeEffects {
            let band: CGFloat = 64
            TimelineView(.animation(minimumInterval: 1.0 / 30)) { context in
                let period = 2.4
                let elapsed = context.date.timeIntervalSinceReferenceDate
                let phase = elapsed.truncatingRemainder(dividingBy: period) / period
                let offset = -band + CGFloat(phase) * (width + band)
                LinearGradient(
                    colors: [.clear, .white.opacity(0.28), .clear],
                    startPoint: .leading, endPoint: .trailing
                )
                .frame(width: band)
                .offset(x: offset)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .allowsHitTesting(false)
        }
    }

    /// One notch per step boundary: the bar shows how many steps the plan has
    /// at a glance, and each notch brightens as the fill passes it.
    @ViewBuilder
    private func ticks(total: Int, width: CGFloat, fraction: Double) -> some View {
        if total > 1, width > 0 {
            ZStack(alignment: .leading) {
                ForEach(Array(1..<total), id: \.self) { index in
                    let position = Double(index) / Double(total)
                    Rectangle()
                        .fill(.white.opacity(position <= fraction + 0.001 ? 0.34 : 0.14))
                        .frame(width: 1, height: Self.railHeight - 10)
                        .offset(x: width * position)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .allowsHitTesting(false)
        }
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
        // Reading surface stays opaque over the scenery, matching PlanCard's
        // markdown body. The list unfolds upward from the rail, so the rail
        // and the credit pill keep their shared baseline.
        .background(
            Color(nsColor: .textBackgroundColor),
            in: RoundedRectangle(cornerRadius: AlpineTheme.Corners.card))
        .overlay {
            RoundedRectangle(cornerRadius: AlpineTheme.Corners.card)
                .strokeBorder(.secondary.opacity(0.18), lineWidth: 1)
        }
        .frame(maxWidth: 520, alignment: .leading)
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
