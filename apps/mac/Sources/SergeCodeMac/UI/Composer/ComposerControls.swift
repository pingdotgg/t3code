import SwiftUI

/// The compact control strip inside the composer: model picker, runtime-mode
/// picker, plan-mode toggle, and the explicitly labelled context-window meter.
struct ComposerControlsRow: View {
    let thread: ChatThread
    let model: AppModel

    var body: some View {
        HStack(spacing: 10) {
            ModelRunProfileGroup(thread: thread, model: model)
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

/// The model remains immediately visible. Lower-frequency tuning lives in one
/// run-profile menu instead of competing with model, access, and interaction
/// mode as separate controls.
private struct ModelRunProfileGroup: View {
    let thread: ChatThread
    let model: AppModel

    private var currentModelOption: ModelOption? {
        model.models.first {
            $0.instanceID == thread.modelInstanceID && $0.modelID == thread.modelID
        }
    }

    private var showsRunProfile: Bool {
        guard let option = currentModelOption else { return false }
        return !option.effortChoices.isEmpty || !option.serviceTierChoices.isEmpty
    }

    var body: some View {
        HStack(spacing: 0) {
            ModelPickerMenu(thread: thread, model: model)
            if showsRunProfile {
                segmentDivider
                RunProfileMenu(thread: thread, model: model)
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

/// Combined reasoning + service-tier chooser. Its summary preserves the
/// active values while the menu groups their full choices by meaning.
private struct RunProfileMenu: View {
    let thread: ChatThread
    let model: AppModel

    @UIState private var isHovering = false
    @UIState private var isPresented = false

    var body: some View {
        if let option = currentModelOption {
            Button {
                isPresented.toggle()
            } label: {
                ComposerSegmentLabel(
                    icon: "slider.horizontal.3",
                    title: summary(of: option),
                    isHovering: isHovering || isPresented
                )
            }
            .buttonStyle(.plain)
            .fixedSize()
            .help("Run profile: reasoning effort and service tier")
            .onHover { isHovering = $0 }
            .popover(isPresented: $isPresented, arrowEdge: .top) {
                runProfilePopover(option)
            }
        }
    }

    private func runProfilePopover(_ option: ModelOption) -> some View {
        ComposerPickerSurface(width: 330) {
            VStack(spacing: 0) {
                ComposerPickerHeader(
                    icon: "slider.horizontal.3",
                    title: "Run profile",
                    subtitle: option.displayName
                )
                Divider().opacity(0.55)
                VStack(spacing: 3) {
                    if !option.effortChoices.isEmpty {
                        ComposerPickerSectionLabel(title: "Reasoning effort")
                        ForEach(option.effortChoices) { choice in
                            ComposerPickerChoiceRow(
                                icon: "brain.head.profile",
                                title: choice.label,
                                detail: choice.isDefault ? "Provider default" : nil,
                                isSelected: choice.id == effectiveEffort(of: option)
                            ) {
                                Task { await model.setReasoningEffort(choice.id) }
                            }
                        }
                    }
                    if showsTier(option) {
                        ComposerPickerSectionLabel(title: "Service tier")
                        ForEach(option.serviceTierChoices) { choice in
                            ComposerPickerChoiceRow(
                                icon: "speedometer",
                                title: choice.label,
                                detail: choice.isDefault ? "Provider default" : nil,
                                isSelected: choice.id == effectiveTier(of: option)
                            ) {
                                Task { await model.setServiceTier(choice.id) }
                            }
                        }
                    }
                }
                .padding(8)
            }
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

    private func effectiveEffort(of option: ModelOption) -> String? {
        thread.reasoningEffort ?? option.effortChoices.first(where: \.isDefault)?.id
    }

    private func effectiveTier(of option: ModelOption) -> String? {
        thread.serviceTier ?? option.serviceTierChoices.first(where: \.isDefault)?.id
    }

    private func showsTier(_ option: ModelOption) -> Bool {
        !isSubagentThread && !option.serviceTierChoices.isEmpty
    }

    private func summary(of option: ModelOption) -> String {
        var parts: [String] = []
        if !option.effortChoices.isEmpty {
            let effort = effectiveEffort(of: option)
            parts.append(option.effortChoices.first { $0.id == effort }?.label ?? "Default")
        }
        if showsTier(option) {
            let tier = effectiveTier(of: option)
            parts.append(option.serviceTierChoices.first { $0.id == tier }?.label ?? "Default")
        }
        return parts.joined(separator: " · ")
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
    @UIState private var isPresented = false

    private var isClamped: Bool { thread.interactionMode.isNonMutating }

    var body: some View {
        Button {
            isPresented.toggle()
        } label: {
            ComposerSegmentLabel(
                icon: thread.effectiveRuntimeMode.symbolName,
                title: thread.effectiveRuntimeMode.displayName,
                isHovering: isHovering || isPresented
            )
        }
        .buttonStyle(.plain)
        .fixedSize()
        .help(
            isClamped
                ? "Advisor mode holds this thread at approvals-required. Your choice applies again when you leave advisor."
                : "How much the agent may do without asking"
        )
        .onHover { isHovering = $0 }
        .popover(isPresented: $isPresented, arrowEdge: .top) {
            runtimeModePopover
        }
    }

    private var runtimeModePopover: some View {
        ComposerPickerSurface(width: 360) {
            VStack(spacing: 0) {
                ComposerPickerHeader(
                    icon: "hand.raised.fingers.spread",
                    title: "Workspace access",
                    subtitle: "Choose what the agent can do without asking"
                )
                if isClamped {
                    HStack(spacing: 7) {
                        Image(systemName: "lightbulb.max.fill")
                        Text("Advisor mode always requires approval.")
                    }
                    .font(.caption.weight(.medium))
                    .foregroundStyle(AlpineTheme.forest)
                    .padding(.horizontal, 10)
                    .frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
                    .background(AlpineTheme.accent.opacity(0.2))
                }
                Divider().opacity(0.55)
                VStack(spacing: 3) {
                    ForEach(ThreadRuntimeMode.allCases) { mode in
                        ComposerPickerChoiceRow(
                            icon: mode.symbolName,
                            title: mode.displayName,
                            detail: runtimeModeDetail(mode),
                            isSelected: mode == thread.runtimeMode
                        ) {
                            Task { await model.setRuntimeMode(mode) }
                            isPresented = false
                        }
                    }
                }
                .padding(8)
            }
        }
    }

    private func runtimeModeDetail(_ mode: ThreadRuntimeMode) -> String {
        switch mode {
        case .approvalRequired: "Ask before editing files or running commands."
        case .autoAcceptEdits: "Edit files freely; ask before broader actions."
        case .fullAccess: "Work independently in the current environment."
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
    @UIState private var isPresented = false

    private var mode: ThreadInteractionMode { thread.interactionMode }

    var body: some View {
        Button {
            isPresented.toggle()
        } label: {
            ComposerSegmentLabel(
                icon: mode.symbolName,
                title: mode.displayName,
                isHovering: isHovering || isPresented,
                isAccented: mode != .normal,
                animateSymbol: true
            )
        }
        .buttonStyle(.plain)
        .fixedSize()
        .animation(Motion.feedback, value: mode)
        .help(mode.helpText)
        .onHover { isHovering = $0 }
        .popover(isPresented: $isPresented, arrowEdge: .top) {
            interactionModePopover
        }
    }

    private var interactionModePopover: some View {
        ComposerPickerSurface(width: 360) {
            VStack(spacing: 0) {
                ComposerPickerHeader(
                    icon: "bubble.left.and.text.bubble.right",
                    title: "Interaction mode",
                    subtitle: "Choose how the agent approaches this request"
                )
                Divider().opacity(0.55)
                VStack(spacing: 3) {
                    ForEach(ThreadInteractionMode.allCases) { choice in
                        ComposerPickerChoiceRow(
                            icon: choice.symbolName,
                            title: choice.displayName,
                            detail: choice.helpText,
                            isSelected: choice == mode
                        ) {
                            Task { await model.setInteractionMode(choice) }
                            isPresented = false
                        }
                    }
                }
                .padding(8)
            }
        }
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
