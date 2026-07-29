import SwiftUI

/// The compact control strip inside the composer: model picker, runtime-mode
/// picker, plan-mode toggle, the auto-PR toggle, and the explicitly labelled
/// context-window meter.
struct ComposerControlsRow: View {
    let thread: ChatThread
    let model: AppModel

    var body: some View {
        HStack(spacing: 10) {
            ModelRunProfileGroup(thread: thread, model: model)
            RuntimePlanModeGroup(thread: thread, model: model)
            if !thread.hasStarted {
                AutoPRToggle()
            }
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
        .animation(Motion.reveal, value: showsRunProfile)
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
    /// Overrides the accent color used when `isAccented` (per-mode tints).
    var tint: Color? = nil
    /// Small leading dot communicating a level color (reasoning effort).
    var leadingDot: Color? = nil
    /// When this value changes, the leading dot plays a one-shot bounce.
    var dotPulse: AnyHashable? = nil

    private var accentColor: Color { tint ?? AlpineTheme.accent }

    var body: some View {
        HStack(spacing: 6) {
            if let leadingDot {
                let dot = Image(systemName: "circle.fill")
                    .font(.system(size: 7))
                    .foregroundStyle(leadingDot)
                    .shadow(color: leadingDot.opacity(0.9), radius: 3)
                // The effort dot changes often; its bounce is decoration the
                // user opted out of, unlike the two modifiers below which are
                // already gated.
                if Motion.reduceMotion {
                    dot
                } else {
                    dot.symbolEffect(.bounce, value: dotPulse)
                }
            }
            Image(systemName: icon)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(isAccented ? accentColor : Color.secondary)
                .contentTransition(
                    animateSymbol && !Motion.reduceMotion
                        ? .symbolEffect(.replace) : .identity)
            Text(title)
                .font(.callout.weight(.medium))
                .foregroundStyle(isAccented ? accentColor : Color.primary)
                .lineLimit(1)
                .contentTransition(Motion.reduceMotion ? .identity : .interpolate)
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
        // Every composer menu routes its hover wash through this label, so
        // animating here is what keeps the run-profile, runtime-mode, and
        // interaction-mode segments from snapping on pointer enter.
        .animation(Motion.feedback, value: isHovering)
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

/// Composer-level "create PR when done" toggle. When on, the first message of
/// a fresh thread carries an extra instruction asking the agent to open a PR
/// for the work once it finishes (see `CreatePRPrompt.messageSuffix`). Only
/// shown for threads that haven't started yet — once a thread has messages,
/// the suffix no longer applies. Persisted globally in UserDefaults so the
/// choice survives thread switches and relaunches.
private struct AutoPRToggle: View {
    @AppStorage(CreatePRPrompt.autoCreateDefaultsKey) private var isOn = false
    @UIState private var isHovering = false

    var body: some View {
        Button {
            Haptics.play(.toggle)
            isOn.toggle()
        } label: {
            ComposerSegmentLabel(
                icon: "arrow.triangle.pull",
                title: "PR",
                isHovering: isHovering,
                isAccented: isOn
            )
        }
        .buttonStyle(.plain)
        .fixedSize()
        .frame(minHeight: AlpineControls.segmentHeight)
        .background(
            .fill.quaternary,
            in: RoundedRectangle(cornerRadius: AlpineTheme.Corners.control, style: .continuous))
        .animation(Motion.feedback, value: isOn)
        .help(
            isOn
                ? "Create PR when done: on — sent messages ask the agent to open a pull request after finishing"
                : "Create PR when done: off"
        )
        .onHover { isHovering = $0 }
    }
}

/// Combined reasoning + service-tier chooser. Its summary preserves the
/// active values while the menu groups their full choices by meaning.
private struct RunProfileMenu: View {
    let thread: ChatThread
    let model: AppModel

    /// Optional because DEBUG probes host composer views without the App's
    /// environment; the row simply hides its shortcut in that case.
    @Environment(SettingsPresentation.self) private var settingsPresentation:
        SettingsPresentation?
    @UIState private var isHovering = false
    @UIState private var isPresented = false
    /// Incremented on each acknowledged effort change to replay the burst.
    @UIState private var burstToken = 0
    /// Guards the burst so opening a thread or first appearance never fires
    /// it — only a genuine effort change on the same thread does.
    @UIState private var lastEffort: String?
    @UIState private var lastThreadID: String?

    var body: some View {
        if let option = currentModelOption {
            Button {
                isPresented.toggle()
            } label: {
                ComposerSegmentLabel(
                    icon: "slider.horizontal.3",
                    title: summary(of: option),
                    isHovering: isHovering || isPresented,
                    leadingDot: effortColor(of: option),
                    dotPulse: effectiveEffort(of: option)
                )
            }
            .buttonStyle(.plain)
            .fixedSize()
            .help("Run profile: reasoning effort and service tier")
            .onHover { isHovering = $0 }
            .background {
                // The ripple lives behind the label at its natural size, so
                // it never moves layout or delays the setting change.
                if burstToken > 0, let color = effortColor(of: option) {
                    EffortBurstView(color: color, token: burstToken)
                }
            }
            .animation(Motion.feedback, value: effectiveEffort(of: option))
            .onAppear {
                lastEffort = effectiveEffort(of: option)
                lastThreadID = thread.id
            }
            .onChange(of: effectiveEffort(of: option)) { oldEffort, newEffort in
                let sameThread = lastThreadID == thread.id
                let firstObservation = lastEffort == nil
                lastEffort = newEffort
                lastThreadID = thread.id
                guard sameThread, !firstObservation, oldEffort != newEffort else { return }
                // The effort ramp is a level, so its change is felt as one —
                // the ripple is decorative and can be off, the step is not.
                Haptics.play(.step)
                guard Motion.profile.allowsDecorativeEffects else { return }
                burstToken += 1
            }
            // UIProbe (DEBUG runs) opens the popover through the section-toggle
            // hook — same-process AX can't press SwiftUI buttons.
            .onReceive(NotificationCenter.default.publisher(for: .uiProbeToggleSection)) { note in
                if note.object as? String == "run-profile" {
                    DispatchQueue.main.async { isPresented.toggle() }
                }
            }
            .popover(isPresented: $isPresented, arrowEdge: .top) {
                runProfilePopover(option)
            }
        }
    }

    private func runProfilePopover(_ option: ModelOption) -> some View {
        ComposerPickerSurface(width: showsEffortSlider(option) ? 380 : 330) {
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
                        if showsEffortSlider(option) {
                            EffortSlider(
                                stops: effortStops(option),
                                selectedID: effectiveEffort(of: option),
                                onSelect: { id in
                                    Task { await model.setReasoningEffort(id) }
                                }
                            )
                            .padding(.horizontal, 2)
                            .padding(.bottom, 2)
                        } else {
                            // A single choice has no ramp to travel; the row
                            // still states which one is in force.
                            ForEach(Array(option.effortChoices.enumerated()), id: \.element.id) { index, choice in
                                let style = EffortLevelStyle.resolve(
                                    choiceID: choice.id, index: index,
                                    count: option.effortChoices.count)
                                ComposerPickerChoiceRow(
                                    icon: style.symbolName,
                                    title: choice.label,
                                    detail: choice.isDefault ? "Provider default" : nil,
                                    isSelected: choice.id == effectiveEffort(of: option),
                                    tint: AlpineTheme.effortColor(slot: style.slot)
                                ) {
                                    Task { await model.setReasoningEffort(choice.id) }
                                }
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
                    if isUltraProfile(option) {
                        Divider()
                            .padding(.vertical, 4)
                        HStack(spacing: 10) {
                            Image(systemName: "point.3.connected.trianglepath.dotted")
                                .foregroundStyle(AlpineTheme.accent)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Sub-agent models")
                                    .font(.callout.weight(.medium))
                                Text("Configure Explore, Implement, and Verify in Settings ▸ Workflows.")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            Spacer(minLength: 8)
                            if settingsPresentation != nil {
                                Button("Open Settings") {
                                    isPresented = false
                                    settingsPresentation?.open(.workflows)
                                }
                                .controlSize(.small)
                            }
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 5)
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

    /// Effort is an ordered level, so two or more choices earn the ramp
    /// slider; a lone choice is not a range and stays a plain row.
    private func showsEffortSlider(_ option: ModelOption) -> Bool {
        option.effortChoices.count > 1
    }

    private func effortStops(_ option: ModelOption) -> [EffortSlider.Stop] {
        option.effortChoices.enumerated().map { index, choice in
            EffortSlider.Stop(
                id: choice.id,
                label: choice.label,
                isProviderDefault: choice.isDefault,
                style: EffortLevelStyle.resolve(
                    choiceID: choice.id, index: index, count: option.effortChoices.count)
            )
        }
    }

    /// Ramp color of the currently effective effort; nil when the model has
    /// no effort choices, so the summary stays dotless for plain models.
    private func effortColor(of option: ModelOption) -> Color? {
        guard let id = effectiveEffort(of: option),
            let index = option.effortChoices.firstIndex(where: { $0.id == id })
        else { return nil }
        let style = EffortLevelStyle.resolve(
            choiceID: id, index: index, count: option.effortChoices.count)
        return AlpineTheme.effortColor(slot: style.slot)
    }

    private func effectiveTier(of option: ModelOption) -> String? {
        thread.serviceTier ?? option.serviceTierChoices.first(where: \.isDefault)?.id
    }

    private func isUltraProfile(_ option: ModelOption) -> Bool {
        guard let effort = effectiveEffort(of: option)?.lowercased() else { return false }
        return effort == "ultra" || effort == "ultracode"
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

/// One-shot colorful ripple behind the run-profile summary when the
/// reasoning effort changes. It lives in the button's background at the
/// control's natural size, so it never moves layout; Reduce Motion never
/// creates it — the tint crossfade alone carries the state change.
private struct EffortBurstView: View {
    let color: Color
    let token: Int

    @UIState private var progress = 0.0

    var body: some View {
        RoundedRectangle(cornerRadius: AlpineTheme.Corners.control, style: .continuous)
            .stroke(color.opacity(0.9), lineWidth: 2)
            .background(
                RoundedRectangle(cornerRadius: AlpineTheme.Corners.control, style: .continuous)
                    .fill(color.opacity(0.30))
            )
            .scaleEffect(1 + progress * 0.22)
            .blur(radius: progress * 3)
            .opacity(1 - progress)
            .allowsHitTesting(false)
            .onChange(of: token, initial: true) { _, _ in
                progress = 0
                withAnimation(Motion.burst) { progress = 1 }
            }
    }
}

/// Menu selecting how much the agent may do without asking.
///
/// Interaction mode (normal / plan) is independent of this permission axis.
private struct RuntimeModeMenu: View {
    let thread: ChatThread
    let model: AppModel

    @UIState private var isHovering = false
    @UIState private var isPresented = false

    var body: some View {
        Button {
            isPresented.toggle()
        } label: {
            ComposerSegmentLabel(
                icon: thread.runtimeMode.symbolName,
                title: thread.runtimeMode.displayName,
                isHovering: isHovering || isPresented,
                isAccented: true,
                animateSymbol: true,
                tint: thread.runtimeMode.tint
            )
        }
        .buttonStyle(.plain)
        .fixedSize()
        // Symbol swap, tint, and title width all ease through one curve, so
        // switching access levels never reads as a layout jump.
        .animation(Motion.feedback, value: thread.runtimeMode)
        .help("How much the agent may do without asking")
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
                Divider().opacity(0.55)
                VStack(spacing: 3) {
                    ForEach(ThreadRuntimeMode.allCases) { mode in
                        ComposerPickerChoiceRow(
                            icon: mode.symbolName,
                            title: mode.displayName,
                            detail: runtimeModeDetail(mode),
                            isSelected: mode == thread.runtimeMode,
                            tint: mode.tint
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
        case .auto: "Let the AI review approval requests before escalating to you."
        case .fullAccess: "Work independently in the current environment."
        }
    }
}

/// Menu selecting how the agent engages with the request: do it (default),
/// plan it, or advise/plan-and-delegate. Mirrors the `/default`, `/plan` and
/// `/advisor` slash commands. When Advisor/Planner is active, also picks the
/// per-thread executor model used for delegated sub-agents and caps how many
/// of them run at once.
private struct InteractionModeMenu: View {
    let thread: ChatThread
    let model: AppModel

    @UIState private var isHovering = false
    @UIState private var isPresented = false
    @UIState private var showingExecutorPicker = false
    /// Live slider position while dragging; flushed to the backend on release.
    @UIState private var maxSubAgentsDraft: Double?

    private var mode: ThreadInteractionMode { thread.interactionMode }

    private var hasExecutor: Bool {
        thread.executorModelInstanceID != nil && thread.executorModelID != nil
    }

    private var maxSubAgentsValue: Int {
        Int(maxSubAgentsDraft ?? Double(thread.executorMaxSubAgents))
    }

    private var advisorDetail: String {
        if let name = executorDisplayName {
            return "Executor: \(name)"
        }
        return ThreadInteractionMode.advisor.helpText
    }

    private var executorDisplayName: String? {
        if let instanceID = thread.executorModelInstanceID,
            let modelID = thread.executorModelID,
            let option = model.models.first(where: {
                $0.instanceID == instanceID && $0.modelID == modelID
            })
        {
            return option.displayName
        }
        return thread.executorModelID
    }

    var body: some View {
        Button {
            isPresented.toggle()
        } label: {
            ComposerSegmentLabel(
                icon: mode.symbolName,
                title: mode.displayName,
                isHovering: isHovering || isPresented,
                isAccented: mode.tint != nil,
                animateSymbol: true,
                tint: mode.tint
            )
        }
        .buttonStyle(.plain)
        .fixedSize()
        .animation(Motion.feedback, value: mode)
        .help(
            mode == .advisor
                ? (executorDisplayName.map { "Advisor/Planner · Executor: \($0)" }
                    ?? mode.helpText)
                : mode.helpText
        )
        .onHover { isHovering = $0 }
        .popover(isPresented: $isPresented, arrowEdge: .top) {
            interactionModePopover
        }
        .onChange(of: isPresented) { _, presented in
            if !presented {
                showingExecutorPicker = false
                maxSubAgentsDraft = nil
            }
        }
    }

    @ViewBuilder
    private var interactionModePopover: some View {
        if showingExecutorPicker {
            ModelPickerPopoverContent(
                models: model.models,
                selectedInstanceID: thread.executorModelInstanceID,
                selectedModelID: thread.executorModelID,
                onSelect: { option in
                    Task {
                        await model.setExecutorModel(
                            instanceID: option.instanceID, modelID: option.modelID)
                    }
                    showingExecutorPicker = false
                },
                title: "Executor model",
                subtitle: "Used for delegated sub-agents",
                clearRow: ModelPickerClearRowConfig(
                    icon: "slash.circle",
                    title: "None — advise only",
                    detail: "Sub-agents will not be spawned with a specific executor",
                    action: {
                        Task { await model.setExecutorModel(instanceID: nil, modelID: nil) }
                        showingExecutorPicker = false
                    }
                ),
                onBack: { showingExecutorPicker = false }
            )
        } else {
            interactionModeList
        }
    }

    private var interactionModeList: some View {
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
                            detail: choice == .advisor ? advisorDetail : choice.helpText,
                            isSelected: choice == mode,
                            tint: choice.tint
                        ) {
                            Task { await model.setInteractionMode(choice) }
                            if choice != .advisor {
                                isPresented = false
                            }
                        }
                    }
                }
                .padding(8)
                if mode == .advisor {
                    Divider().opacity(0.55)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Executor model")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 10)
                            .padding(.top, 8)
                        ComposerPickerChoiceRow(
                            icon: "cpu",
                            title: "Executor model",
                            detail: executorDisplayName ?? "None — advise only",
                            isSelected: false
                        ) {
                            showingExecutorPicker = true
                        }
                        if hasExecutor {
                            maxSubAgentsRow
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.bottom, 8)
                }
            }
        }
    }

    /// Cap on concurrently spawned executor sub-agents; flushed on drag end so
    /// the backend sees one command per adjustment, not one per tick.
    private var maxSubAgentsRow: some View {
        HStack(spacing: 12) {
            Slider(
                value: Binding(
                    get: { maxSubAgentsDraft ?? Double(thread.executorMaxSubAgents) },
                    set: { newValue in
                        let previous = Int(maxSubAgentsDraft ?? Double(thread.executorMaxSubAgents))
                        maxSubAgentsDraft = newValue
                        // A stepped slider has detents in its values but none
                        // under the finger; each whole-number crossing ticks,
                        // and the two ends thud instead.
                        let next = Int(newValue)
                        guard next != previous else { return }
                        Haptics.play(next == 1 || next == 10 ? .boundary : .step)
                    }
                ),
                in: 1...10,
                step: 1,
                label: {
                    Text("Max sub-agents")
                },
                minimumValueLabel: {
                    Text("1")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                },
                maximumValueLabel: {
                    Text("10")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                },
                onEditingChanged: { editing in
                    guard !editing, let draft = maxSubAgentsDraft else { return }
                    maxSubAgentsDraft = nil
                    Task {
                        await model.setExecutorModel(
                            instanceID: thread.executorModelInstanceID,
                            modelID: thread.executorModelID,
                            maxSubAgents: Int(draft))
                    }
                }
            )
            .accessibilityLabel("Max sub-agents")
            .accessibilityValue("\(maxSubAgentsValue)")

            Text("\(maxSubAgentsValue)")
                .font(.body.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(minWidth: 24, alignment: .trailing)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
    }
}

/// Compact context-window usage meter (ring + percent). Resting the pointer
/// on it opens a popover with the full numbers (used / limit / remaining).
struct ContextMeterView: View {
    let status: ContextWindowStatus

    @UIState private var showDetails = false
    @UIState private var hoverTask: Task<Void, Never>?

    var body: some View {
        if let fraction = status.usedFraction {
            // Hovering is the pointer affordance, but the numbers behind it
            // (limit, remaining, the near-full warning) must not be
            // pointer-exclusive — the button makes them clickable, keyboard
            // focusable, and reachable by the VoiceOver cursor.
            Button {
                // A click landing inside the 400 ms hover delay would otherwise
                // be immediately undone by the pending timer.
                hoverTask?.cancel()
                hoverTask = nil
                showDetails.toggle()
            } label: {
                HStack(spacing: 5) {
                    Circle()
                        .trim(from: 0, to: max(0.02, fraction))
                        .stroke(
                            meterColor(fraction),
                            style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                        .background(Circle().stroke(.quaternary, lineWidth: 2.5))
                        .frame(width: 12, height: 12)
                    Text("Context \(Int((fraction * 100).rounded()))%")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                        .contentTransition(.numericText())
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { scheduleDetails(hovering: $0) }
            .popover(isPresented: $showDetails, arrowEdge: .top) {
                ContextMeterDetails(status: status, fraction: fraction, tint: meterColor(fraction))
            }
            .accessibilityLabel("Context window")
            .accessibilityValue(accessibilityValue(fraction))
            .accessibilityHint("Shows exact token usage")
            .onDisappear {
                hoverTask?.cancel()
                hoverTask = nil
                showDetails = false
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

    /// Everything the details popover shows, spoken in one go — the ring is an
    /// undescribed shape, so the percent alone would be the whole story.
    private func accessibilityValue(_ fraction: Double) -> String {
        let percent = Int((fraction * 100).rounded())
        var value = "\(percent)% used, \(status.usedTokens.formatted()) tokens"
        if let maxTokens = status.maxTokens {
            value += " of \(maxTokens.formatted()), "
            value += "\(max(0, maxTokens - status.usedTokens).formatted()) remaining"
        }
        if fraction >= 0.9 {
            value += ". Nearly full — the provider may compact older history soon"
        }
        return value
    }

    private func meterColor(_ fraction: Double) -> Color {
        switch fraction {
        case ..<0.7: AlpineTheme.meadow
        case ..<0.9: AlpineTheme.clay
        default: .red
        }
    }

    /// Presents the details card only once the pointer has rested: transient
    /// passes (window drags, scrolls) must never present and dismiss a popover
    /// in quick succession. The meter's anchor is rebuilt constantly while a
    /// turn streams (and removed entirely when `usedFraction` flips to nil),
    /// and presenting a popover while its anchor is mid-teardown crashes
    /// inside NSPopover's child-window ordering (NSRemoteView / ViewBridge).
    private func scheduleDetails(hovering: Bool) {
        hoverTask?.cancel()
        hoverTask = nil
        if hovering {
            hoverTask = Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(400))
                guard !Task.isCancelled else { return }
                showDetails = true
            }
        } else {
            showDetails = false
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
