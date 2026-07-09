import SwiftUI

/// The compact control strip above the composer input: model picker,
/// runtime-mode picker, plan-mode toggle, and the context-window meter.
struct ComposerControlsRow: View {
    let thread: ChatThread
    let model: AppModel

    var body: some View {
        HStack(spacing: 10) {
            ModelEffortTierGroup(thread: thread, model: model)
            RuntimeModeMenu(thread: thread, model: model)
            PlanModeToggle(thread: thread, model: model)
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

/// Visually grouped model + effort + tier controls as a single capsule strip.
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
        .background(.fill.tertiary, in: Capsule())
    }

    private var segmentDivider: some View {
        Rectangle()
            .fill(.separator)
            .frame(width: 1, height: 12)
            .padding(.horizontal, 1)
    }
}

/// Shared label chrome for compact menu segments inside the capsule group.
private struct ComposerSegmentLabel: View {
    let icon: String
    let title: String
    var isHovering: Bool = false

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: icon)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(title)
                .font(.caption.weight(.medium))
                .foregroundStyle(.primary)
                .lineLimit(1)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .background {
            if isHovering {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(.fill.secondary)
            }
        }
    }
}

/// Reasoning-effort picker for the thread's current model. Hidden when the
/// model exposes no effort option descriptor (e.g. Cursor's composer).
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
        if let option = currentModelOption, !option.serviceTierChoices.isEmpty {
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

    private func effectiveTier(of option: ModelOption) -> String? {
        thread.serviceTier ?? option.serviceTierChoices.first(where: \.isDefault)?.id
    }

    private func currentLabel(of option: ModelOption) -> String {
        let tier = effectiveTier(of: option)
        return option.serviceTierChoices.first { $0.id == tier }?.label ?? "Tier"
    }
}

/// Menu selecting how much the agent may do without asking.
private struct RuntimeModeMenu: View {
    let thread: ChatThread
    let model: AppModel

    var body: some View {
        Menu {
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
        } label: {
            Label(thread.runtimeMode.displayName, systemImage: thread.runtimeMode.symbolName)
                .font(.caption.weight(.medium))
                .foregroundStyle(.primary)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
    }
}

/// One-tap plan-mode toggle (mirrors the web client's /plan `/default`).
private struct PlanModeToggle: View {
    let thread: ChatThread
    let model: AppModel

    private var isPlan: Bool { thread.interactionMode == .plan }

    var body: some View {
        Button {
            Task { await model.setInteractionMode(isPlan ? .normal : .plan) }
        } label: {
            Label("Plan", systemImage: isPlan ? "list.clipboard.fill" : "list.clipboard")
                .font(.caption.weight(.medium))
                .contentTransition(.symbolEffect(.replace))
        }
        .buttonStyle(.plain)
        .foregroundStyle(isPlan ? Color.accentColor : Color.primary)
        .animation(Motion.snap, value: isPlan)
        .help(isPlan ? "Plan mode on — the agent proposes a plan instead of editing" : "Turn on plan mode")
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
                Text("\(Int((fraction * 100).rounded()))%")
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
        case ..<0.7: .green
        case ..<0.9: .orange
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
