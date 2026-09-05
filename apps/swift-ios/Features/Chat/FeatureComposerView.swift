import AVFoundation
import SwiftUI
import UIKit

struct FeatureModelRefreshError: LocalizedError {
    var errorDescription: String? { "Couldn’t refresh models." }
}

struct FeatureComposerUploadStatus {
    var preparingCount = 0
    var uploadingCount = 0
    var failures: [(UUID, String)] = []

    init(states: [(UUID, FeatureAttachmentUploadState?)]) {
        for (id, state) in states {
            switch state {
            case .some(.ready): break
            case let .some(.failed(message)): failures.append((id, message))
            case .some(.uploading): uploadingCount += 1
            case .some(.queued), .none: preparingCount += 1
            }
        }
    }

    var blocksSend: Bool {
        preparingCount > 0 || uploadingCount > 0 || !failures.isEmpty
    }
}

struct FeatureComposerView: View {
    @SwiftUI.Environment(\.scenePhase) private var scenePhase
    @State private var isManuallyExpanded = false
    @State private var isAttachmentFlowActive = false
    @State private var isModelPickerPresented = false
    @State private var restoresFocusAfterModelPickerDismissal = false
    @State private var attachmentPreparation = FeatureAttachmentPreparationState()
    @State private var pathEntries: [FeatureComposerPathEntry] = []
    @State private var isPathSearchLoading = false
    @State private var pathSearchError: String?
    @State private var textSelectionRequest: FeatureComposerTextSelectionRequest?
    @State private var imageIntakeErrorMessage: String?
    @State private var textRevision: UInt64 = 0
    @State private var textObservation = FeatureComposerTextObservation()
    @State private var voiceInputController = FeatureVoiceInputController()
    @Binding private var text: String
    @Binding private var selection: FeatureSelection?
    @Binding private var attachments: [FeatureDraftAttachment]

    private let providers: [FeatureProvider]
    private let draftOwnerID: String
    private let environmentID: String?
    private let draftStorageKey: String?
    private let environmentIsConnected: Bool
    private let attachmentUploads: FeatureAttachmentUploadCoordinator
    private let attachmentPreferences: FeatureEnvironmentPreferences
    private let onRefreshModels: (() async throws -> Void)?
    private let draftSaveError: String?
    private let onRetryDraftSave: (() -> Void)?
    private let threadSelection: FeatureSelection?
    private let materializesDefaultSelection: Bool
    private let isSending: Bool
    private let isWorking: Bool
    @Binding private var focused: Bool
    private let contextUsage: Double?
    private let forceExpanded: Bool
    private let pendingApprovals: [FeatureApproval]
    private let pendingUserInputs: [FeatureUserInput]
    private let isResolvingRequest: Bool
    private let powerFeatures: FeatureComposerPowerFeatures
    private let onSend: () -> Void
    private let onStop: () -> Void
    private let onDismissKeyboard: (() -> Void)?
    private let onApprovalDecision: ((String, FeatureApprovalDecision) -> Void)?
    private let onUserInputSubmit: ((String, [String: FeatureInputAnswer]) -> Void)?

    init(
        text: Binding<String>,
        selection: Binding<FeatureSelection?>,
        attachments: Binding<[FeatureDraftAttachment]>,
        draftOwnerID: String,
        environmentID: String?,
        draftStorageKey: String?,
        environmentIsConnected: Bool,
        attachmentUploads: FeatureAttachmentUploadCoordinator,
        attachmentPreferences: FeatureEnvironmentPreferences,
        providers: [FeatureProvider],
        threadSelection: FeatureSelection?,
        materializesDefaultSelection: Bool = true,
        isSending: Bool,
        isWorking: Bool,
        focused: Binding<Bool>,
        onSend: @escaping () -> Void,
        onStop: @escaping () -> Void,
        contextUsage: Double? = nil,
        forceExpanded: Bool = false,
        pendingApprovals: [FeatureApproval] = [],
        pendingUserInputs: [FeatureUserInput] = [],
        isResolvingRequest: Bool = false,
        powerFeatures: FeatureComposerPowerFeatures = .disabled,
        onDismissKeyboard: (() -> Void)? = nil,
        onApprovalDecision: ((String, FeatureApprovalDecision) -> Void)? = nil,
        onUserInputSubmit: ((String, [String: FeatureInputAnswer]) -> Void)? = nil,
        onRefreshModels: (() async throws -> Void)? = nil,
        draftSaveError: String? = nil,
        onRetryDraftSave: (() -> Void)? = nil
    ) {
        _text = text
        _selection = selection
        _attachments = attachments
        self.draftOwnerID = draftOwnerID
        self.environmentID = environmentID
        self.draftStorageKey = draftStorageKey
        self.environmentIsConnected = environmentIsConnected
        self.attachmentUploads = attachmentUploads
        self.attachmentPreferences = attachmentPreferences
        self.onRefreshModels = onRefreshModels
        self.draftSaveError = draftSaveError
        self.onRetryDraftSave = onRetryDraftSave
        self.providers = providers
        self.threadSelection = threadSelection
        self.materializesDefaultSelection = materializesDefaultSelection
        self.isSending = isSending
        self.isWorking = isWorking
        _focused = focused
        self.onSend = onSend
        self.onStop = onStop
        self.contextUsage = contextUsage
        self.forceExpanded = forceExpanded
        self.pendingApprovals = pendingApprovals
        self.pendingUserInputs = pendingUserInputs
        self.isResolvingRequest = isResolvingRequest
        self.powerFeatures = powerFeatures
        self.onDismissKeyboard = onDismissKeyboard
        self.onApprovalDecision = onApprovalDecision
        self.onUserInputSubmit = onUserInputSubmit
    }

    var body: some View {
        composerSurface
            .overlay(alignment: .top) {
                if showsCommandMenu, let trigger = composerTrigger {
                    // Offset by the menu's deterministic height so it sits
                    // fully above the composer and the active `$`/`@`/`/`
                    // token stays readable while typing. An alignment-guide
                    // override here never actually moved the menu, which
                    // left it covering the text entry.
                    FeatureComposerCommandPopover(
                        triggerKind: trigger.kind,
                        items: commandMenuItems,
                        isLoading: isPathSearchLoading,
                        errorMessage: pathSearchError,
                        pathSearchAvailable: powerFeatures.searchPaths != nil,
                        onSelect: selectCommandItem
                    )
                    .offset(
                        y: -(FeatureComposerCommandPopover.height(
                            forItemCount: commandMenuItems.count
                        ) + 12)
                    )
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
            .onChange(of: focused) {
                if FeatureComposerCollapsePolicy.shouldCollapse(
                    isFocused: focused,
                    textIsEmpty: textIsEmpty,
                    attachmentsAreEmpty: attachments.isEmpty,
                    isAttachmentFlowActive: isAttachmentFlowActive || isModelPickerPresented,
                    isPreparingAttachments: attachmentPreparation.isPreparing
                ) {
                    isManuallyExpanded = false
                }
            }
            .task(id: pathSearchRequest) {
                await updatePathSearch()
            }
            .onAppear {
                synchronizeVoiceDraft(ownerChanged: false)
            }
            .onDisappear {
                voiceInputController.cancel()
            }
            .onChange(of: text) {
                textRevision &+= 1
                synchronizeVoiceDraft(ownerChanged: false)
            }
            .onChange(of: draftOwnerID) {
                synchronizeVoiceDraft(ownerChanged: true)
            }
            .onChange(of: voiceInputController.pendingCommit?.id) {
                applyPendingVoiceCommit()
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .background {
                    voiceInputController.appMovedToBackground()
                }
            }
            .onReceive(NotificationCenter.default.publisher(
                for: AVAudioSession.interruptionNotification
            )) { notification in
                guard let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey]
                        as? UInt,
                      AVAudioSession.InterruptionType(rawValue: rawType) == .began else { return }
                voiceInputController.recordingWasInterrupted()
            }
            .alert(
                "Couldn’t add image",
                isPresented: Binding(
                    get: { imageIntakeErrorMessage != nil },
                    set: { if !$0 { imageIntakeErrorMessage = nil } }
                )
            ) {
                Button("OK") { imageIntakeErrorMessage = nil }
            } message: {
                Text(imageIntakeErrorMessage ?? "")
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
        .modifier(
            FeatureComposerImageDrop(
                isEnabled: imagesAllowed && !voiceInputController.isBusy,
                shape: composerShape,
                onDropImages: attachDroppedImages
            )
        )
    }

    private var collapsedComposer: some View {
        HStack(spacing: 4) {
            Button {
                isManuallyExpanded = true
                Task { @MainActor in
                    await Task.yield()
                    focused = true
                }
            } label: {
                Text(composerPlaceholder)
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

            if voiceInputController.isSupported {
                voiceInputButton
                    .padding(.trailing, 3)
            }
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
                    .padding(.bottom, 8)
                    .fixedSize(horizontal: false, vertical: true)

                Divider()
                    .overlay(T3Colors.separator)
                    .padding(.horizontal, 13)
            }

            // Return is always editing input. Sending is deliberately
            // button-only, which is UITextView's native return behavior.
            ZStack(alignment: .topLeading) {
                FeatureComposerTextInput(
                    text: $text,
                    focused: $focused,
                    placeholder: composerPlaceholder,
                    acceptsImages: imagesAllowed,
                    isReadOnly: voiceInputController.isBusy,
                    skills: powerFeatures.enabledSkills,
                    selectionRequest: textSelectionRequest,
                    onSelectionChange: handleTextSelectionChange,
                    onPasteImages: attachImageProviders,
                    onDismissKeyboard: onDismissKeyboard
                )
                .padding(.horizontal, 16)
                .padding(.top, 14)

                if text.isEmpty {
                    Text(composerPlaceholder)
                        .font(T3Typography.composer)
                        .foregroundStyle(T3Colors.textTertiary)
                        .padding(.horizontal, 16)
                        .padding(.top, 14)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
            .padding(.bottom, 7)
            .frame(minHeight: 62, alignment: .top)
            .layoutPriority(1)
            .clipped()

            if let attachmentBlocker {
                Label(attachmentBlocker, systemImage: "exclamationmark.circle")
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

            if let draftSaveError {
                HStack(spacing: 8) {
                    Text(draftSaveError).lineLimit(3)
                    Spacer(minLength: 0)
                    if let onRetryDraftSave {
                        Button("Retry", action: onRetryDraftSave)
                    }
                }
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.danger)
                .padding(.horizontal, 15)
                .padding(.bottom, 4)
                .accessibilityIdentifier("composer-draft-save-error")
            } else if uploadStatus.blocksSend {
                uploadStatusView(uploadStatus)
            }

            if voiceInputController.phase == .error {
                voiceInputError
            }

            composerFooter
                .fixedSize(horizontal: false, vertical: true)
                .layoutPriority(1)
        }
    }

    private var composerFooter: some View {
        Group {
            if voiceInputController.isBusy {
                voiceInputFooter
            } else {
                standardComposerFooter
            }
        }
    }

    private var standardComposerFooter: some View {
        HStack(spacing: 2) {
            FeatureImageAttachmentPicker(
                attachments: $attachments,
                preparationState: $attachmentPreparation,
                isFlowActive: $isAttachmentFlowActive,
                draftOwnerID: draftOwnerID,
                environmentID: environmentID,
                imagesAllowed: imagesAllowed,
                maximumFileBytes: attachmentPreferences.maxFileAttachmentBytes
            )

            ProviderModelPicker(
                providers: providers,
                selection: $selection,
                style: .compact,
                threadSelection: threadSelection,
                materializesDefaultSelection: materializesDefaultSelection,
                onRefresh: onRefreshModels,
                onPresentationChange: handleModelPickerPresentation
            )
            .frame(maxWidth: 220, alignment: .leading)
            .layoutPriority(2)

            Spacer(minLength: 0)

            if voiceInputController.isSupported {
                voiceInputButton
            }

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

    private var voiceInputButton: some View {
        Button(action: startVoiceInput) {
            Image(systemName: "mic")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(T3Colors.textSecondary)
                .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Start voice input")
        .accessibilityIdentifier("voice-input-start")
    }

    private var voiceInputFooter: some View {
        HStack(spacing: 8) {
            voiceInputStatus
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textSecondary)

            Spacer(minLength: 0)

            Button("Cancel") {
                voiceInputController.cancel()
            }
            .font(T3Typography.supporting)
            .foregroundStyle(T3Colors.textSecondary)
            .frame(minHeight: T3Metrics.minimumTapTarget)

            if voiceInputController.phase == .recording {
                Button("Stop") {
                    voiceInputController.stop()
                }
                .font(T3Typography.supporting.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 12)
                .frame(minHeight: 34)
                .background(T3Colors.accent, in: Capsule())
                .frame(minHeight: T3Metrics.minimumTapTarget)
                .accessibilityLabel("Stop recording and transcribe")
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 2)
        .padding(.bottom, 8)
    }

    @ViewBuilder
    private var voiceInputStatus: some View {
        switch voiceInputController.phase {
        case .preparing:
            Text("Preparing")
        case .recording:
            TimelineView(.periodic(from: .now, by: 1)) { context in
                Text("Recording \(voiceRecordingDuration(at: context.date))")
                    .monospacedDigit()
            }
        case .transcribing:
            Text("Transcribing")
        case .idle, .error:
            EmptyView()
        }
    }

    private var voiceInputError: some View {
        HStack(spacing: 8) {
            Text(voiceInputController.errorMessage ?? "Voice input failed.")
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.danger)
                .frame(maxWidth: .infinity, alignment: .leading)

            if let action = voiceInputController.errorAction {
                Button(action == .settings ? "Settings" : "Retry") {
                    if action == .settings,
                       let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    } else {
                        startVoiceInput()
                    }
                }
                .font(T3Typography.supporting.weight(.semibold))
            }

            Button("Dismiss") {
                voiceInputController.cancel()
            }
            .font(T3Typography.supporting)
            .foregroundStyle(T3Colors.textSecondary)
        }
        .padding(.horizontal, 15)
        .padding(.bottom, 4)
    }

    private var submitButton: some View {
        Button(action: performPrimaryAction) {
            Image(systemName: submitSymbol)
                .font(.system(size: showsStop ? 11 : 14, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 34, height: 34)
                .background(showsStop ? T3Colors.danger : T3Colors.accent, in: Circle())
                .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(submitDisabled)
        .opacity(submitDisabled ? 0.3 : 1)
        .accessibilityLabel(submitAccessibilityLabel)
        .accessibilityIdentifier(showsStop ? "thread-stop" : "message-send")
    }

    private var composerPlaceholder: String {
        isWorking ? "Queue a message…" : "Ask anything…"
    }

    private var submitSymbol: String {
        if isSending { return "ellipsis" }
        return showsStop ? "stop.fill" : "arrow.up"
    }

    private var submitAccessibilityLabel: String {
        if isSending { return "Sending message" }
        if showsStop { return "Stop agent" }
        return isWorking ? "Queue message" : "Send message"
    }

    private var composerShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: 22, style: .continuous)
    }

    private var isExpanded: Bool {
        forceExpanded
            || isManuallyExpanded
            || focused
            || !textIsEmpty
            || !attachments.isEmpty
            || attachmentPreparation.isPreparing
            || voiceInputController.isBusy
            || voiceInputController.phase == .error
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
            filesAllowed: attachmentPreferences.maxFileAttachmentBytes != nil,
            containsImages: attachments.contains { $0.mimeType.hasPrefix("image/") },
            containsFiles: attachments.contains { !$0.mimeType.hasPrefix("image/") },
            isSending: isSending,
            preparationState: attachmentPreparation
        ) && !uploadStatus.blocksSend && draftSaveError == nil
    }

    private var imagesAllowed: Bool {
        DailyUXModelOptions.supportsImages(
            selection: selection ?? threadSelection,
            providers: providers
        )
    }

    private var attachmentBlocker: String? {
        if attachments.contains(where: { !$0.mimeType.hasPrefix("image/") }),
           attachmentPreferences.maxFileAttachmentBytes == nil {
            return "This environment does not accept file attachments"
        }
        if attachments.contains(where: { $0.mimeType.hasPrefix("image/") }), !imagesAllowed {
            return "Choose a model that accepts images"
        }
        return nil
    }

    private var applicableUploadStates: [(UUID, FeatureAttachmentUploadState?)] {
        guard environmentIsConnected, let environmentID, draftStorageKey != nil else { return [] }
        return attachments.compactMap { attachment in
            let isImage = attachment.mimeType.hasPrefix("image/")
            let uploadsHere = isImage
                ? attachmentPreferences.supportsImageUploads
                : attachmentPreferences.maxFileAttachmentBytes != nil
            guard uploadsHere else { return nil }
            return (
                attachment.id,
                attachmentUploads.state(
                    environmentID: environmentID,
                    attachmentID: attachment.id
                )
            )
        }
    }

    private var uploadStatus: FeatureComposerUploadStatus {
        FeatureComposerUploadStatus(states: applicableUploadStates)
    }

    private func uploadStatusView(_ status: FeatureComposerUploadStatus) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if status.preparingCount > 0 {
                Text("Preparing \(status.preparingCount) attachment\(status.preparingCount == 1 ? "" : "s")")
            }
            if status.uploadingCount > 0 {
                Text("Uploading \(status.uploadingCount) attachment\(status.uploadingCount == 1 ? "" : "s")")
            }
            ForEach(status.failures, id: \.0) { failure in
                HStack(spacing: 8) {
                    Text(failure.1).lineLimit(2)
                    Spacer(minLength: 0)
                    Button("Retry") {
                        guard let environmentID else { return }
                        attachmentUploads.retry(
                            environmentID: environmentID,
                            attachmentID: failure.0
                        )
                    }
                }
            }
        }
        .font(T3Typography.supporting)
        .foregroundStyle(status.failures.isEmpty ? T3Colors.textSecondary : T3Colors.danger)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 15)
        .padding(.bottom, 4)
        .accessibilityIdentifier("attachment-upload-status")
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
            && !voiceInputController.isBusy
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
            replacement = skill.invocation
        case let .path(entry):
            replacement = FeatureComposerFileLinkSerializer.markdownLink(for: entry.path) + " "
        }
        let nextCursorLocation = FeatureComposerTextSelectionPolicy.cursorLocation(
            afterReplacing: trigger.range,
            in: text,
            with: replacement
        )
        text = FeatureComposerTriggerParser.replacing(
            trigger.range,
            in: text,
            with: replacement
        )
        // Publish the text first so the representable cannot consume and clamp
        // this request against the pre-replacement draft.
        textSelectionRequest = FeatureComposerTextSelectionRequest(
            location: nextCursorLocation
        )
        pathEntries = []
        pathSearchError = nil
        Task { @MainActor in
            await Task.yield()
            focused = true
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

    private func startVoiceInput() {
        synchronizeVoiceDraft(ownerChanged: false)
        voiceInputController.start()
    }

    private func handleTextSelectionChange(_ selection: NSRange) {
        textObservation.selection = selection
        voiceInputController.updateSelection(selection)
    }

    private func synchronizeVoiceDraft(ownerChanged: Bool) {
        let snapshot = FeatureVoiceDraftSnapshot(
            ownerID: draftOwnerID,
            text: text,
            revision: textRevision,
            selection: textObservation.selection
        )
        if ownerChanged {
            voiceInputController.ownerChanged(to: snapshot)
        } else {
            voiceInputController.updateDraft(snapshot)
        }
    }

    private func applyPendingVoiceCommit() {
        guard let commit = voiceInputController.pendingCommit else { return }
        textSelectionRequest = FeatureComposerTextSelectionRequest(
            location: commit.caretLocation
        )
        text = commit.text
        voiceInputController.consumePendingCommit()
    }

    private func voiceRecordingDuration(at date: Date) -> String {
        let seconds = max(0, Int(date.timeIntervalSince(
            voiceInputController.recordingStartedAt ?? date
        )))
        return String(format: "%02d:%02d", seconds / 60, seconds % 60)
    }

    private func handleModelPickerPresentation(_ isPresented: Bool) {
        if isPresented {
            restoresFocusAfterModelPickerDismissal = focused
            isManuallyExpanded = true
            isModelPickerPresented = true
            return
        }

        isModelPickerPresented = false
        guard restoresFocusAfterModelPickerDismissal else { return }
        restoresFocusAfterModelPickerDismissal = false
        Task { @MainActor in
            await Task.yield()
            focused = true
        }
    }

    /// Attaches images arriving from the text view's paste menu or a drag
    /// from another app through the same preparation pipeline the attachment
    /// picker uses, so sending stays blocked until every image is processed.
    private func attachImageProviders(_ providers: [NSItemProvider]) {
        guard imagesAllowed, !providers.isEmpty else { return }

        guard let plan = FeatureComposerImageIntakePlan.forProviders(
            providerCount: providers.count,
            attachmentCount: attachments.count,
            pendingCount: attachmentPreparation.pendingItemCount
        ) else {
            imageIntakeErrorMessage = "You can attach up to eight images."
            return
        }
        if plan.droppedCount > 0 {
            imageIntakeErrorMessage =
                "Some images were not attached because the eight-image limit was reached."
        }

        let accepted = Array(providers.prefix(plan.acceptedCount))
        // Begin every provider request while the paste or drop callback still
        // owns access to its item providers. Image processing can finish
        // asynchronously after the callback returns.
        let loads = accepted.map { provider in
            Result { try FeatureImageItemProviderLoader.start(from: provider) }
        }
        let operation = attachmentPreparation.begin(itemCount: accepted.count)
        Task { @MainActor in
            defer { attachmentPreparation.finish(operation) }
            for (offset, load) in loads.enumerated() {
                do {
                    let data = try await load.get().data()
                    let attachment = try await Task.detached(priority: .userInitiated) {
                        try FeatureImageProcessor.attachment(
                            from: data,
                            ordinal: plan.firstOrdinal + offset
                        )
                    }.value
                    attachments.append(attachment)
                } catch {
                    imageIntakeErrorMessage = error.localizedDescription
                }
            }
        }
    }

    /// A drop is refused outright when images are not accepted, so the drag
    /// session shows the system's "not allowed" badge instead of a dead drop.
    private func attachDroppedImages(_ providers: [NSItemProvider]) -> Bool {
        guard imagesAllowed, !providers.isEmpty else { return false }
        attachImageProviders(providers)
        return true
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
        filesAllowed: Bool = false,
        containsImages: Bool = true,
        containsFiles: Bool = false,
        isSending: Bool,
        preparationState: FeatureAttachmentPreparationState
    ) -> Bool {
        let hasText = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let hasAttachments = attachmentCount > 0
        return !isSending
            && !preparationState.isPreparing
            && (hasText || hasAttachments)
            && (!hasAttachments || !containsImages || imagesAllowed)
            && (!hasAttachments || !containsFiles || filesAllowed)
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
