import SwiftUI

struct FeatureComposerView: View {
    @State private var isManuallyExpanded = false
    @State private var isAttachmentFlowActive = false
    @State private var attachmentPreparation = FeatureAttachmentPreparationState()
    @State private var pathEntries: [FeatureComposerPathEntry] = []
    @State private var isPathSearchLoading = false
    @State private var pathSearchError: String?
    @Binding private var text: String
    @Binding private var selection: FeatureSelection?
    @Binding private var attachments: [FeatureDraftAttachment]

    private let providers: [FeatureProvider]
    private let threadSelection: FeatureSelection?
    private let materializesDefaultSelection: Bool
    private let isSending: Bool
    private let isWorking: Bool
    private let focused: FocusState<Bool>.Binding
    private let contextUsage: Double?
    private let forceExpanded: Bool
    private let pendingApprovals: [FeatureApproval]
    private let pendingUserInputs: [FeatureUserInput]
    private let isResolvingRequest: Bool
    private let powerFeatures: FeatureComposerPowerFeatures
    private let onSend: () -> Void
    private let onStop: () -> Void
    private let onApprovalDecision: ((String, FeatureApprovalDecision) -> Void)?
    private let onUserInputSubmit: ((String, [String: FeatureInputAnswer]) -> Void)?

    init(
        text: Binding<String>,
        selection: Binding<FeatureSelection?>,
        attachments: Binding<[FeatureDraftAttachment]>,
        providers: [FeatureProvider],
        threadSelection: FeatureSelection?,
        materializesDefaultSelection: Bool = true,
        isSending: Bool,
        isWorking: Bool,
        focused: FocusState<Bool>.Binding,
        onSend: @escaping () -> Void,
        onStop: @escaping () -> Void,
        contextUsage: Double? = nil,
        forceExpanded: Bool = false,
        pendingApprovals: [FeatureApproval] = [],
        pendingUserInputs: [FeatureUserInput] = [],
        isResolvingRequest: Bool = false,
        powerFeatures: FeatureComposerPowerFeatures = .disabled,
        onApprovalDecision: ((String, FeatureApprovalDecision) -> Void)? = nil,
        onUserInputSubmit: ((String, [String: FeatureInputAnswer]) -> Void)? = nil
    ) {
        _text = text
        _selection = selection
        _attachments = attachments
        self.providers = providers
        self.threadSelection = threadSelection
        self.materializesDefaultSelection = materializesDefaultSelection
        self.isSending = isSending
        self.isWorking = isWorking
        self.focused = focused
        self.onSend = onSend
        self.onStop = onStop
        self.contextUsage = contextUsage
        self.forceExpanded = forceExpanded
        self.pendingApprovals = pendingApprovals
        self.pendingUserInputs = pendingUserInputs
        self.isResolvingRequest = isResolvingRequest
        self.powerFeatures = powerFeatures
        self.onApprovalDecision = onApprovalDecision
        self.onUserInputSubmit = onUserInputSubmit
    }

    var body: some View {
        composerSurface
            .overlay(alignment: .top) {
                if showsCommandMenu, let trigger = composerTrigger {
                    FeatureComposerCommandPopover(
                        triggerKind: trigger.kind,
                        items: commandMenuItems,
                        isLoading: isPathSearchLoading,
                        errorMessage: pathSearchError,
                        pathSearchAvailable: powerFeatures.searchPaths != nil,
                        onSelect: selectCommandItem
                    )
                    .alignmentGuide(.top) { dimensions in
                        // Keep the menu clear of the text entry surface so the
                        // active `$`/`@`/`/` token remains readable while typing.
                        dimensions[.bottom] + 24
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 12)
            .padding(.bottom, 10)
            .background {
                LinearGradient(
                    colors: [
                        .clear,
                        T3Colors.background.opacity(0.94),
                        T3Colors.background,
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .ignoresSafeArea()
            }
            .onChange(of: focused.wrappedValue) {
                if FeatureComposerCollapsePolicy.shouldCollapse(
                    isFocused: focused.wrappedValue,
                    textIsEmpty: textIsEmpty,
                    attachmentsAreEmpty: attachments.isEmpty,
                    isAttachmentFlowActive: isAttachmentFlowActive,
                    isPreparingAttachments: attachmentPreparation.isPreparing
                ) {
                    isManuallyExpanded = false
                }
            }
            .task(id: pathSearchRequest) {
                await updatePathSearch()
            }
    }

    private var composerSurface: some View {
        VStack(spacing: 0) {
            if let approval = pendingApprovals.first, let onApprovalDecision {
                FeatureComposerApprovalPanel(
                    approval: approval,
                    position: 1,
                    total: pendingApprovals.count,
                    isResponding: isResolvingRequest,
                    onDecision: { decision in
                        onApprovalDecision(approval.id, decision)
                    },
                    onCancelTurn: onStop
                )
            } else if let input = pendingUserInputs.first, let onUserInputSubmit {
                FeatureComposerUserInputPanel(
                    input: input,
                    isResponding: isResolvingRequest,
                    onSubmit: { answers in
                        onUserInputSubmit(input.id, answers)
                    }
                )
            } else if isExpanded {
                expandedComposer
            } else {
                collapsedComposer
            }
        }
        .background(T3Colors.input.opacity(0.98), in: composerShape)
        .overlay {
            composerShape
                .stroke(T3Colors.inputBorder, lineWidth: 1)
        }
        .clipShape(composerShape)
    }

    private var collapsedComposer: some View {
        HStack(spacing: 4) {
            Button {
                isManuallyExpanded = true
                Task { @MainActor in
                    await Task.yield()
                    focused.wrappedValue = true
                }
            } label: {
                Text(isWorking ? "Message to queue…" : "Ask anything…")
                    .font(T3Typography.composer)
                    .foregroundStyle(T3Colors.textTertiary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .frame(minHeight: T3Metrics.minimumTapTarget)
            .accessibilityLabel("Message agent")
            .accessibilityHint("Opens the message editor")

            submitButton
                .padding(.trailing, 7)
        }
        .padding(.leading, 14)
        .padding(.vertical, 7)
    }

    private var expandedComposer: some View {
        VStack(spacing: 0) {
            if !attachments.isEmpty {
                FeatureAttachmentStrip(attachments: $attachments)
                    .padding(.horizontal, 12)
                    .padding(.top, 3)

                Divider()
                    .overlay(T3Colors.separator)
                    .padding(.horizontal, 13)
            }

            TextField(
                isWorking ? "Message to queue…" : "Ask anything…",
                text: $text,
                axis: .vertical
            )
                .font(T3Typography.composer)
                .lineLimit(1...7)
                .focused(focused)
                // Return is always editing input. Sending is deliberately button-only.
                .submitLabel(.return)
                .padding(.horizontal, 16)
                .padding(.top, 14)
                .padding(.bottom, 7)
                .frame(minHeight: 62, alignment: .top)

            if !attachments.isEmpty, !imagesAllowed {
                Label("Choose a model that accepts images", systemImage: "exclamationmark.circle")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.warning)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 15)
                    .padding(.bottom, 4)
            }

            if attachmentPreparation.isPreparing {
                Label(attachmentPreparation.statusLabel, systemImage: "hourglass")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 15)
                    .padding(.bottom, 4)
                    .accessibilityIdentifier("attachment-preparing")
            }

            composerFooter
        }
    }

    private var composerFooter: some View {
        HStack(spacing: 2) {
            FeatureImageAttachmentPicker(
                attachments: $attachments,
                preparationState: $attachmentPreparation,
                isFlowActive: $isAttachmentFlowActive,
                isEnabled: imagesAllowed
            )

            ProviderModelPicker(
                providers: providers,
                selection: $selection,
                style: .compact,
                threadSelection: threadSelection,
                materializesDefaultSelection: materializesDefaultSelection
            )
            .frame(maxWidth: 220, alignment: .leading)
            .layoutPriority(2)

            Spacer(minLength: 0)

            if let contextUsage {
                FeatureContextMeter(usage: contextUsage)
            }

            submitButton
                .padding(.leading, 4)
        }
        .padding(.horizontal, 7)
        .padding(.top, 2)
        .padding(.bottom, 8)
    }

    private var submitButton: some View {
        Button(action: performPrimaryAction) {
            Group {
                if isSending {
                    ProgressView()
                        .controlSize(.small)
                        .tint(.white)
                } else {
                    Image(systemName: showsStop ? "stop.fill" : "arrow.up")
                        .font(.system(size: showsStop ? 11 : 14, weight: .bold))
                }
            }
            .foregroundStyle(.white)
            .frame(width: 34, height: 34)
            .background(showsStop ? T3Colors.danger : T3Colors.accent, in: Circle())
        }
        .buttonStyle(.plain)
        .disabled(submitDisabled)
        .opacity(submitDisabled ? 0.3 : 1)
        .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
        .contentShape(Rectangle())
        .accessibilityLabel(showsStop ? "Stop agent" : "Send")
        .accessibilityIdentifier(showsStop ? "thread-stop" : "message-send")
    }

    private var composerShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: 22, style: .continuous)
    }

    private var isExpanded: Bool {
        forceExpanded
            || isManuallyExpanded
            || focused.wrappedValue
            || !textIsEmpty
            || !attachments.isEmpty
            || attachmentPreparation.isPreparing
    }

    private var showsStop: Bool {
        isWorking && textIsEmpty && attachments.isEmpty
    }

    private var submitDisabled: Bool {
        isSending || (!showsStop && !canSend)
    }

    private var textIsEmpty: Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var canSend: Bool {
        guard composerTrigger?.kind != .model else { return false }
        return FeatureComposerSubmissionEligibility.canSend(
            text: text,
            attachmentCount: attachments.count,
            imagesAllowed: imagesAllowed,
            isSending: isSending,
            preparationState: attachmentPreparation
        )
    }

    private var imagesAllowed: Bool {
        DailyUXModelOptions.supportsImages(
            selection: selection ?? threadSelection,
            providers: providers
        )
    }

    /// Trigger detection walks the whole draft with character indices and is
    /// read from several computed properties per body evaluation, so one parse
    /// per keystroke is memoized instead of four.
    private final class TriggerMemo {
        var text: String?
        var trigger: FeatureComposerTrigger?
    }

    @State private var triggerMemo = TriggerMemo()

    private var composerTrigger: FeatureComposerTrigger? {
        if triggerMemo.text == text { return triggerMemo.trigger }
        let trigger = FeatureComposerTriggerParser.detect(in: text)
        triggerMemo.text = text
        triggerMemo.trigger = trigger
        return trigger
    }

    private var commandMenuItems: [FeatureComposerMenuItem] {
        guard let composerTrigger else { return [] }
        return FeatureComposerMenuBuilder.items(
            trigger: composerTrigger,
            providers: providers,
            currentSelection: selection,
            threadSelection: threadSelection,
            powerFeatures: powerFeatures,
            pathEntries: pathEntries
        )
    }

    private var showsCommandMenu: Bool {
        isExpanded
            && pendingApprovals.isEmpty
            && pendingUserInputs.isEmpty
            && composerTrigger != nil
    }

    private var pathSearchRequest: FeatureComposerPathSearchRequest? {
        guard let trigger = composerTrigger,
              trigger.kind == .path,
              powerFeatures.searchPaths != nil else {
            return nil
        }
        let query = trigger.query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return nil }
        return FeatureComposerPathSearchRequest(
            scopeID: powerFeatures.pathSearchScopeID,
            query: query
        )
    }

    @MainActor
    private func updatePathSearch() async {
        guard let request = pathSearchRequest, let searchPaths = powerFeatures.searchPaths else {
            pathEntries = []
            isPathSearchLoading = false
            pathSearchError = nil
            return
        }

        pathEntries = []
        pathSearchError = nil
        isPathSearchLoading = true
        do {
            try await Task.sleep(for: .milliseconds(140))
            let result = try await searchPaths(request.query)
            guard !Task.isCancelled else { return }
            pathEntries = result
            isPathSearchLoading = false
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled else { return }
            pathSearchError = "Couldn’t search files."
            isPathSearchLoading = false
        }
    }

    private func selectCommandItem(_ item: FeatureComposerMenuItem) {
        guard let trigger = composerTrigger else { return }
        let replacement: String
        switch item {
        case .modelCommand:
            replacement = "/model "
        case let .model(nextSelection, _, _):
            selection = nextSelection
            replacement = ""
        case let .providerCommand(command):
            replacement = "/\(command.name) "
        case let .skill(skill):
            replacement = "$\(skill.name) "
        case let .path(entry):
            replacement = FeatureComposerFileLinkSerializer.markdownLink(for: entry.path) + " "
        }
        text = FeatureComposerTriggerParser.replacing(
            trigger.range,
            in: text,
            with: replacement
        )
        pathEntries = []
        pathSearchError = nil
        Task { @MainActor in
            await Task.yield()
            focused.wrappedValue = true
        }
    }

    private func performPrimaryAction() {
        if showsStop {
            onStop()
        } else if FeatureComposerSubmissionPolicy.allowsSend(for: .explicitButton),
                  canSend {
            onSend()
        }
    }
}

enum FeatureComposerCollapsePolicy {
    static func shouldCollapse(
        isFocused: Bool,
        textIsEmpty: Bool,
        attachmentsAreEmpty: Bool,
        isAttachmentFlowActive: Bool,
        isPreparingAttachments: Bool
    ) -> Bool {
        !isFocused
            && textIsEmpty
            && attachmentsAreEmpty
            && !isAttachmentFlowActive
            && !isPreparingAttachments
    }
}

private struct FeatureComposerPathSearchRequest: Hashable {
    let scopeID: String
    let query: String
}

enum FeatureComposerSubmissionEligibility {
    static func canSend(
        text: String,
        attachmentCount: Int,
        imagesAllowed: Bool,
        isSending: Bool,
        preparationState: FeatureAttachmentPreparationState
    ) -> Bool {
        let hasText = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let hasAttachments = attachmentCount > 0
        return !isSending
            && !preparationState.isPreparing
            && (hasText || hasAttachments)
            && (!hasAttachments || imagesAllowed)
    }
}

enum FeatureComposerSubmissionIntent: Equatable {
    case explicitButton
    case returnKey
}

enum FeatureComposerSubmissionPolicy {
    static func allowsSend(for intent: FeatureComposerSubmissionIntent) -> Bool {
        intent == .explicitButton
    }
}

private struct FeatureContextMeter: View {
    let usage: Double

    var body: some View {
        ZStack {
            Circle()
                .stroke(T3Colors.border, lineWidth: 2)
            Circle()
                .trim(from: 0, to: clampedUsage)
                .stroke(
                    T3Colors.textSecondary,
                    style: StrokeStyle(lineWidth: 2, lineCap: .round)
                )
                .rotationEffect(.degrees(-90))
        }
        .frame(width: 18, height: 18)
        .frame(width: 30, height: T3Metrics.minimumTapTarget)
        .accessibilityElement()
        .accessibilityLabel("Context used")
        .accessibilityValue("\(Int((clampedUsage * 100).rounded())) percent")
    }

    private var clampedUsage: Double {
        min(max(usage, 0), 1)
    }
}
