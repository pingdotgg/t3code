import SwiftUI

/// The compact control strip inside the composer: model picker, runtime-mode
/// picker, plan-mode toggle, and the explicitly labelled context-window meter.
struct ComposerControlsRow: View {
    let thread: ChatThread
    let model: AppModel

    var body: some View {
        HStack(spacing: 10) {
            ModelEffortTierGroup(thread: thread, model: model)
            RuntimePlanModeGroup(thread: thread, model: model)
            Spacer()
            if let status = model.threadState(thread.id)?.contextWindow {
                ContextMeterView(status: status)
                    .transition(Motion.materialize)
            }
        }
        .padding(.horizontal, 4)
        .animation(Motion.ambient, value: model.threadState(thread.id)?.contextWindow == nil)
    }
}

/// Visually grouped model + effort + tier controls as one compact neutral bar.
private struct ModelEffortTierGroup: View {
    let thread: ChatThread
    let model: AppModel

    private var currentModelOption: ModelOption? {
        model.models.first {
            $0.instanceID == thread.modelInstanceID && $0.modelID == thread.modelID
        }
    }

    private var showsEffort: Bool {
        guard let option = currentModelOption else { return false }
        return !option.effortChoices.isEmpty
    }

    private var showsTier: Bool {
        guard let option = currentModelOption else { return false }
        return !option.serviceTierChoices.isEmpty
    }

    var body: some View {
        HStack(spacing: 0) {
            ModelPickerMenu(thread: thread, model: model)
            if showsEffort {
                segmentDivider
                EffortMenu(thread: thread, model: model)
            }
            if showsTier {
                segmentDivider
                ServiceTierMenu(thread: thread, model: model)
            }
        }
        .frame(minHeight: AlpineControls.segmentHeight)
        .background(
            .fill.quaternary,
            in: RoundedRectangle(cornerRadius: AlpineTheme.Corners.control, style: .continuous))
    }

    private var segmentDivider: some View {
        Rectangle()
            .fill(.separator)
            .frame(width: 1, height: 18)
            .padding(.horizontal, 2)
    }
}

/// Shared label chrome for segments inside the compact glass control groups.
private struct ComposerSegmentLabel: View {
    let icon: String
    let title: String
    var isHovering: Bool = false
    /// When true, icon + title use the accent color (e.g. plan mode on).
    var isAccented: Bool = false
    /// When true, icon changes animate with a symbol replace transition.
    var animateSymbol: Bool = false

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(isAccented ? AlpineTheme.accent : Color.secondary)
                .contentTransition(
                    animateSymbol && !Motion.reduceMotion
                        ? .symbolEffect(.replace) : .identity)
            Text(title)
                .font(.callout.weight(.medium))
                .foregroundStyle(isAccented ? AlpineTheme.accent : Color.primary)
                .lineLimit(1)
        }
        .padding(.horizontal, AlpineControls.segmentHorizontalPadding)
        .padding(.vertical, AlpineControls.segmentVerticalPadding)
        .contentShape(Rectangle())
        .background {
            if isHovering {
                RoundedRectangle(cornerRadius: AlpineTheme.Corners.compact, style: .continuous)
                    .fill(.fill.secondary)
            }
        }
    }
}

/// Visually grouped access-level and interaction-mode controls.
private struct RuntimePlanModeGroup: View {
    let thread: ChatThread
    let model: AppModel

    var body: some View {
        HStack(spacing: 0) {
            RuntimeModeMenu(thread: thread, model: model)
            segmentDivider
            InteractionModeMenu(thread: thread, model: model)
        }
        .frame(minHeight: AlpineControls.segmentHeight)
        .background(
            .fill.quaternary,
            in: RoundedRectangle(cornerRadius: AlpineTheme.Corners.control, style: .continuous))
    }

    private var segmentDivider: some View {
        Rectangle()
            .fill(.separator)
            .frame(width: 1, height: 18)
            .padding(.horizontal, 2)
    }
}

/// Reasoning-effort picker for the thread's current model. Hidden when the
/// model exposes no effort option descriptor.
private struct EffortMenu: View {
    let thread: ChatThread
    let model: AppModel

    @UIState private var isHovering = false

    var body: some View {
        if let option = currentModelOption, !option.effortChoices.isEmpty {
            Menu {
                ForEach(option.effortChoices) { choice in
                    Button {
                        Task { await model.setReasoningEffort(choice.id) }
                    } label: {
                        if choice.id == effectiveEffort(of: option) {
                            Label(choice.label, systemImage: "checkmark")
                        } else {
                            Text(choice.label)
                        }
                    }
                }
            } label: {
                ComposerSegmentLabel(
                    icon: "brain",
                    title: currentLabel(of: option),
                    isHovering: isHovering
                )
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .help("Reasoning effort")
            .onHover { isHovering = $0 }
        }
    }

    private var currentModelOption: ModelOption? {
        model.models.first {
            $0.instanceID == thread.modelInstanceID && $0.modelID == thread.modelID
        }
    }

    /// Explicit thread selection, else the model's default choice.
    private func effectiveEffort(of option: ModelOption) -> String? {
        thread.reasoningEffort ?? option.effortChoices.first(where: \.isDefault)?.id
    }

    private func currentLabel(of option: ModelOption) -> String {
        let effort = effectiveEffort(of: option)
        return option.effortChoices.first { $0.id == effort }?.label ?? "Effort"
    }
}

/// Service-tier picker for the thread's current model (e.g. Standard / Fast).
/// Hidden when the model exposes no serviceTier option descriptor.
private struct ServiceTierMenu: View {
    let thread: ChatThread
    let model: AppModel

    @UIState private var isHovering = false

    var body: some View {
        if !isSubagentThread, let option = currentModelOption,
            !option.serviceTierChoices.isEmpty
        {
            Menu {
                ForEach(option.serviceTierChoices) { choice in
                    Button {
                        Task { await model.setServiceTier(choice.id) }
                    } label: {
                        if choice.id == effectiveTier(of: option) {
                            Label(choice.label, systemImage: "checkmark")
                        } else {
                            Text(choice.label)
                        }
                    }
                }
            } label: {
                ComposerSegmentLabel(
                    icon: "bolt",
                    title: currentLabel(of: option),
                    isHovering: isHovering
                )
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .help("Service tier")
            .onHover { isHovering = $0 }
        }
    }

    private var currentModelOption: ModelOption? {
        model.models.first {
            $0.instanceID == thread.modelInstanceID && $0.modelID == thread.modelID
        }
    }

    private var isSubagentThread: Bool {
        thread.title.trimmingCharacters(in: .whitespacesAndNewlines)
            .range(of: #"^Agent:\s*"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    private func effectiveTier(of option: ModelOption) -> String? {
        thread.serviceTier ?? option.serviceTierChoices.first(where: \.isDefault)?.id
    }

    private func currentLabel(of option: ModelOption) -> String {
        let tier = effectiveTier(of: option)
        return option.serviceTierChoices.first { $0.id == tier }?.label ?? "Tier"
    }
}

/// Menu selecting how much the agent may do without asking.
///
/// The label shows the mode actually in force, which is not always the thread's
/// stored mode: advisor clamps it to approvals-required. The checkmark stays on
/// the stored choice, so leaving advisor restores what the user picked.
private struct RuntimeModeMenu: View {
    let thread: ChatThread
    let model: AppModel

    @UIState private var isHovering = false

    private var isClamped: Bool { thread.interactionMode.isNonMutating }

    var body: some View {
        Menu {
            if isClamped {
                Section("Advisor is read-only — approvals required") {
                    modeButtons
                }
            } else {
                modeButtons
            }
        } label: {
            ComposerSegmentLabel(
                icon: thread.effectiveRuntimeMode.symbolName,
                title: thread.effectiveRuntimeMode.displayName,
                isHovering: isHovering
            )
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help(
            isClamped
                ? "Advisor mode holds this thread at approvals-required. Your choice applies again when you leave advisor."
                : "How much the agent may do without asking"
        )
        .onHover { isHovering = $0 }
    }

    private var modeButtons: some View {
        ForEach(ThreadRuntimeMode.allCases) { mode in
            Button {
                Task { await model.setRuntimeMode(mode) }
            } label: {
                if mode == thread.runtimeMode {
                    Label(mode.displayName, systemImage: "checkmark")
                } else {
                    Label(mode.displayName, systemImage: mode.symbolName)
                }
            }
        }
    }
}

/// Menu selecting how the agent engages with the request: do it (default),
/// plan it, or advise on it. Mirrors the `/default`, `/plan` and `/advisor`
/// slash commands.
private struct InteractionModeMenu: View {
    let thread: ChatThread
    let model: AppModel

    @UIState private var isHovering = false

    private var mode: ThreadInteractionMode { thread.interactionMode }

    var body: some View {
        Menu {
            ForEach(ThreadInteractionMode.allCases) { choice in
                Button {
                    Task { await model.setInteractionMode(choice) }
                } label: {
                    if choice == mode {
                        Label(choice.displayName, systemImage: "checkmark")
                    } else {
                        Label(choice.displayName, systemImage: choice.symbolName)
                    }
                }
                .help(choice.helpText)
            }
        } label: {
            ComposerSegmentLabel(
                icon: mode.symbolName,
                title: mode.displayName,
                isHovering: isHovering,
                isAccented: mode != .normal,
                animateSymbol: true
            )
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .animation(Motion.feedback, value: mode)
        .help(mode.helpText)
        .onHover { isHovering = $0 }
    }
}

/// Compact context-window usage meter (ring + percent). Hovering opens a
/// popover with the full numbers (used / limit / remaining).
struct ContextMeterView: View {
    let status: ContextWindowStatus

    @UIState private var showDetails = false

    var body: some View {
        if let fraction = status.usedFraction {
            HStack(spacing: 5) {
                Circle()
                    .trim(from: 0, to: max(0.02, fraction))
                    .stroke(meterColor(fraction), style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .background(Circle().stroke(.quaternary, lineWidth: 2.5))
                    .frame(width: 12, height: 12)
                Text("Context \(Int((fraction * 100).rounded()))%")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                    .contentTransition(.numericText())
            }
            .onHover { showDetails = $0 }
            .popover(isPresented: $showDetails, arrowEdge: .top) {
                ContextMeterDetails(status: status, fraction: fraction, tint: meterColor(fraction))
            }
            // The ring sweeps and the percent ticks as usage grows.
            .animation(Motion.ambient, value: fraction)
        } else {
            Label("\(status.usedTokens.formatted()) tokens", systemImage: "gauge")
                .font(.caption)
                .foregroundStyle(.secondary)
                .help("\(status.usedTokens.formatted()) context tokens used; this model reports no window limit")
        }
    }

    private func meterColor(_ fraction: Double) -> Color {
        switch fraction {
        case ..<0.7: AlpineTheme.meadow
        case ..<0.9: AlpineTheme.clay
        default: .red
        }
    }
}

/// Hover card behind the context meter: exact token numbers and a usage bar.
private struct ContextMeterDetails: View {
    let status: ContextWindowStatus
    let fraction: Double
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Context window")
                .font(.headline)
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 3) {
                GridRow {
                    Text("Used").foregroundStyle(.secondary)
                    Text("\(status.usedTokens.formatted()) tokens (\(Int((fraction * 100).rounded()))%)")
                        .monospacedDigit()
                }
                if let maxTokens = status.maxTokens {
                    GridRow {
                        Text("Limit").foregroundStyle(.secondary)
                        Text("\(maxTokens.formatted()) tokens").monospacedDigit()
                    }
                    GridRow {
                        Text("Remaining").foregroundStyle(.secondary)
                        Text("\(max(0, maxTokens - status.usedTokens).formatted()) tokens")
                            .monospacedDigit()
                    }
                }
            }
            .font(.caption)
            ProgressView(value: fraction)
                .tint(tint)
                .controlSize(.small)
            if fraction >= 0.9 {
                Text("Nearly full — the provider may compact older history soon.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .frame(width: 240, alignment: .leading)
    }
}
