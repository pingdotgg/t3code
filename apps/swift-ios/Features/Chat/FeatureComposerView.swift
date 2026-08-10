import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct FeatureComposerView: View {
    @State private var isManuallyExpanded = false
    @State private var isAttachmentFlowActive = false
    @State private var attachmentPreparation = FeatureAttachmentPreparationState()
    @State private var attachmentLifecycle: FeatureAttachmentLifecycle
    @State private var pasteQueue: FeatureComposerPasteQueue
    @State private var pathEntries: [FeatureComposerPathEntry] = []
    @State private var isPathSearchLoading = false
    @State private var pathSearchError: String?
    @State private var attachmentErrorMessage: String?
    @State private var textSelectionRequest: FeatureComposerTextSelectionRequest?
    @Binding private var text: String
    @Binding private var selection: FeatureSelection?
    @Binding private var attachments: [FeatureDraftAttachment]

    private let providers: [FeatureProvider]
    private let threadSelection: FeatureSelection?
    private let materializesDefaultSelection: Bool
    private let isSending: Bool
    private let isWorking: Bool
    private let attachmentContextID: String
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
        attachmentContextID: String,
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
        let attachmentLifecycle = FeatureAttachmentLifecycle(contextID: attachmentContextID)
        _attachmentLifecycle = State(initialValue: attachmentLifecycle)
        _pasteQueue = State(
            initialValue: FeatureComposerPasteQueue(lifecycle: attachmentLifecycle)
        )
        self.providers = providers
        self.threadSelection = threadSelection
        self.attachmentContextID = attachmentContextID
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
                        dimensions[.bottom] + 8
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
            .onChange(of: attachmentContextID) {
                rotateAttachmentLifecycle(to: attachmentContextID)
            }
            .alert(
                "Couldn’t paste image",
                isPresented: Binding(
                    get: { attachmentErrorMessage != nil },
                    set: { if !$0 { attachmentErrorMessage = nil } }
                )
            ) {
                Button("OK") { attachmentErrorMessage = nil }
            } message: {
                Text(attachmentErrorMessage ?? "")
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

            let placeholder = isWorking ? "Message to queue…" : "Ask anything…"
            ZStack(alignment: .topLeading) {
                FeatureComposerTextInput(
                    text: $text,
                    focused: focused,
                    placeholder: placeholder,
                    acceptsImages: imagesAllowed,
                    selectionRequest: textSelectionRequest,
                    onPasteImages: loadPastedImages
                )
                .padding(.horizontal, 16)
                .padding(.top, 14)

                if text.isEmpty {
                    Text(placeholder)
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

    private func loadPastedImages(_ providers: [NSItemProvider]) {
        guard imagesAllowed,
              let lifecycleToken = attachmentLifecycle.token(for: attachmentContextID) else {
            return
        }
        let imageProviders = providers.filter {
            $0.hasItemConformingToTypeIdentifier(UTType.image.identifier)
        }
        guard !imageProviders.isEmpty else { return }

        guard let operation = attachmentPreparation.reserve(
            itemCount: imageProviders.count,
            attachments: attachments
        ) else {
            attachmentErrorMessage = "You can attach up to eight images."
            return
        }
        let reservedProviders = Array(imageProviders.prefix(operation.count))
        if operation.count < imageProviders.count {
            attachmentErrorMessage =
                "Some images were not attached because the eight-image limit was reached."
        }

        guard pasteQueue.enqueue(token: lifecycleToken, { @MainActor in
            defer { self.attachmentPreparation.finish(operation) }
            let result: FeatureImagePasteBatchResult
            do {
                result = try await FeatureImagePasteBatchLoader.prepare(
                    providers: reservedProviders
                )
            } catch is CancellationError {
                return
            } catch {
                self.attachmentErrorMessage = error.localizedDescription
                return
            }
            guard !Task.isCancelled,
                  self.attachmentLifecycle.isCurrent(lifecycleToken) else { return }
            let accepted = FeatureImageAttachmentPolicy.attachmentsToAppend(
                result.attachments,
                to: self.attachments
            )
            if accepted.count < result.attachments.count {
                self.attachmentErrorMessage =
                    "Some images were not attached because the eight-image limit was reached."
            } else if let failureMessage = result.failureMessage {
                self.attachmentErrorMessage = failureMessage
            }
            self.attachments.append(contentsOf: accepted)
        }) != nil else {
            attachmentPreparation.finish(operation)
            return
        }
    }

    private var composerFooter: some View {
        HStack(spacing: 2) {
            FeatureImageAttachmentPicker(
                attachments: $attachments,
                preparationState: $attachmentPreparation,
                isFlowActive: $isAttachmentFlowActive,
                lifecycle: attachmentLifecycle,
                attachmentContextID: attachmentContextID,
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
        let cursorLocation = FeatureComposerTextSelectionPolicy.cursorLocation(
            afterReplacing: trigger.range,
            in: text,
            with: replacement
        )
        text = FeatureComposerTriggerParser.replacing(
            trigger.range,
            in: text,
            with: replacement
        )
        textSelectionRequest = FeatureComposerTextSelectionRequest(
            location: cursorLocation
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
            rotateAttachmentLifecycle(to: attachmentContextID)
            onSend()
        }
    }

    private func rotateAttachmentLifecycle(to contextID: String) {
        attachmentLifecycle.transition(to: contextID)
        pasteQueue.cancelAll()
        attachmentPreparation.cancelAll()
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

@MainActor
final class FeatureComposerPasteQueue {
    private var tail: Task<Void, Never>?
    private let lifecycle: FeatureAttachmentLifecycle

    init(lifecycle: FeatureAttachmentLifecycle) {
        self.lifecycle = lifecycle
    }

    @discardableResult
    func enqueue(
        token: FeatureAttachmentLifecycle.Token,
        _ work: @escaping @MainActor () async -> Void
    ) -> Task<Void, Never>? {
        guard lifecycle.isCurrent(token) else { return nil }
        let previous = tail
        let task = Task { @MainActor [weak self] in
            await previous?.value
            guard let self,
                  self.lifecycle.isCurrent(token),
                  !Task.isCancelled else { return }
            await work()
        }
        tail = task
        return task
    }

    func cancelAll() {
        tail?.cancel()
        tail = nil
    }

}

final class FeatureComposerUITextView: UITextView {
    var acceptsImages = false {
        didSet {
            guard oldValue != acceptsImages else { return }
            pasteConfiguration = acceptsImages
                ? UIPasteConfiguration(
                    acceptableTypeIdentifiers: [
                        UTType.image.identifier,
                        UTType.text.identifier,
                    ]
                )
                : nil
        }
    }
    var onPasteImages: (([NSItemProvider]) -> Void)?

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)),
           acceptsImages,
           FeatureComposerPasteboardPolicy.containsImage(in: UIPasteboard.general) {
            return true
        }
        return super.canPerformAction(action, withSender: sender)
    }

    override func paste(_ sender: Any?) {
        guard acceptsImages else {
            super.paste(sender)
            return
        }
        let imageProviders = UIPasteboard.general.itemProviders.filter {
            $0.hasItemConformingToTypeIdentifier(UTType.image.identifier)
        }
        guard !imageProviders.isEmpty else {
            super.paste(sender)
            return
        }
        if let pastedText = FeatureComposerPasteTextPolicy.text(
            from: UIPasteboard.general
        ) {
            insertText(pastedText)
        }
        onPasteImages?(imageProviders)
    }
}

enum FeatureComposerPasteboardPolicy {
    static func containsImage(in pasteboard: UIPasteboard) -> Bool {
        pasteboard.contains(pasteboardTypes: [UTType.image.identifier])
    }
}

struct FeatureComposerTextSelectionRequest: Equatable {
    let id = UUID()
    let location: Int
}

enum FeatureComposerTextSelectionPolicy {
    static func cursorLocation(
        afterReplacing range: Range<Int>,
        in text: String,
        with replacement: String
    ) -> Int {
        let lower = min(max(range.lowerBound, 0), text.count)
        let lowerIndex = text.index(text.startIndex, offsetBy: lower)
        return text[..<lowerIndex].utf16.count + replacement.utf16.count
    }

    static func cursorLocationAfterBindingUpdate(previousText: String, newText: String, selectedLocation: Int) -> Int {
        previousText.isEmpty ? newText.utf16.count : min(selectedLocation, newText.utf16.count)
    }
}

enum FeatureComposerPasteTextPolicy {
    static func text(from pasteboard: UIPasteboard) -> String? {
        let strings = (0..<pasteboard.numberOfItems).compactMap { itemIndex -> String? in
            let itemSet = IndexSet(integer: itemIndex)
            let typeIdentifiers = pasteboard.types(forItemSet: itemSet)?
                .first ?? []
            guard !typeIdentifiers.contains(where: {
                UTType($0)?.conforms(to: .image) == true
            }) else { return nil }

            for typeIdentifier in preferredPlainTextTypes(in: typeIdentifiers) {
                if let value = pasteboard.values(
                    forPasteboardType: typeIdentifier,
                    inItemSet: itemSet
                )?.first as? String,
                   !value.isEmpty {
                    return value
                }
            }
            return nil
        }
        guard !strings.isEmpty else { return nil }
        return strings.joined(separator: "\n")
    }

    private static func preferredPlainTextTypes(
        in typeIdentifiers: [String]
    ) -> [String] {
        typeIdentifiers
            .filter { UTType($0)?.conforms(to: .plainText) == true }
            .sorted { lhs, rhs in
                (plainTextPriority(lhs), lhs) < (plainTextPriority(rhs), rhs)
            }
    }

    private static func plainTextPriority(_ typeIdentifier: String) -> Int {
        if typeIdentifier == UTType.utf8PlainText.identifier { return 0 }
        if typeIdentifier == UTType.plainText.identifier { return 1 }
        return 2
    }
}

private struct FeatureComposerTextInput: UIViewRepresentable {
    @Binding var text: String
    let focused: FocusState<Bool>.Binding
    let placeholder: String
    let acceptsImages: Bool
    let selectionRequest: FeatureComposerTextSelectionRequest?
    let onPasteImages: ([NSItemProvider]) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeUIView(context: Context) -> FeatureComposerUITextView {
        let textView = FeatureComposerUITextView()
        context.coordinator.lastAppliedSelectionRequestID = selectionRequest?.id
        textView.delegate = context.coordinator
        textView.acceptsImages = acceptsImages
        textView.onPasteImages = onPasteImages
        textView.backgroundColor = .clear
        textView.textColor = UIColor(T3Colors.textPrimary)
        textView.tintColor = UIColor(T3Colors.accent)
        textView.font = UIFont.preferredFont(forTextStyle: .body)
        textView.adjustsFontForContentSizeCategory = true
        textView.textContainerInset = .zero
        textView.textContainer.lineFragmentPadding = 0
        textView.isScrollEnabled = true
        textView.accessibilityIdentifier = "message-composer"
        updateAccessibility(textView)
        return textView
    }

    func updateUIView(_ textView: FeatureComposerUITextView, context: Context) {
        context.coordinator.parent = self
        textView.acceptsImages = acceptsImages
        textView.onPasteImages = onPasteImages

        let shouldApplySelection = selectionRequest.map {
            context.coordinator.lastAppliedSelectionRequestID != $0.id
        } ?? false
        if textView.text != text {
            let previousText = textView.text ?? ""
            let selectedRange = textView.selectedRange
            textView.text = text
            if !shouldApplySelection {
                let location = FeatureComposerTextSelectionPolicy.cursorLocationAfterBindingUpdate(
                    previousText: previousText, newText: text, selectedLocation: selectedRange.location
                )
                let length = previousText.isEmpty ? 0 : min(selectedRange.length, text.utf16.count - location)
                textView.selectedRange = NSRange(location: location, length: length)
                textView.scrollRangeToVisible(textView.selectedRange)
            }
        }
        if shouldApplySelection, let selectionRequest {
            let location = min(selectionRequest.location, textView.text.utf16.count)
            textView.selectedRange = NSRange(location: location, length: 0)
            textView.scrollRangeToVisible(textView.selectedRange)
            context.coordinator.lastAppliedSelectionRequestID = selectionRequest.id
        }
        updateAccessibility(textView)
        textView.isScrollEnabled = true

        if context.coordinator.lastAppliedFocus != focused.wrappedValue {
            context.coordinator.lastAppliedFocus = focused.wrappedValue
            if focused.wrappedValue, !textView.isFirstResponder {
                textView.becomeFirstResponder()
            } else if !focused.wrappedValue, textView.isFirstResponder {
                textView.resignFirstResponder()
            }
        }
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiView: FeatureComposerUITextView,
        context: Context
    ) -> CGSize? {
        guard let width = proposal.width, width.isFinite else { return nil }
        let fittingSize = uiView.sizeThatFits(
            CGSize(width: width, height: .greatestFiniteMagnitude)
        )
        return CGSize(
            width: width,
            height: FeatureComposerTextInputSizing.height(
                fittingHeight: fittingSize.height,
                proposedHeight: proposal.height,
                lineHeight: uiView.font?.lineHeight ?? 22
            )
        )
    }

    private func updateAccessibility(_ textView: FeatureComposerUITextView) {
        textView.accessibilityLabel = "Message agent"
        textView.accessibilityHint = acceptsImages
            ? "Enter a message or paste images to attach them."
            : "Enter a message."
        textView.accessibilityValue = text.isEmpty ? placeholder : nil
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: FeatureComposerTextInput
        var lastAppliedFocus: Bool?
        var lastAppliedSelectionRequestID: UUID?

        init(_ parent: FeatureComposerTextInput) {
            self.parent = parent
        }

        func textViewDidChange(_ textView: UITextView) {
            textView.isScrollEnabled = true
            guard parent.text != textView.text else { return }
            parent.text = textView.text
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            if !parent.focused.wrappedValue {
                parent.focused.wrappedValue = true
            }
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            if parent.focused.wrappedValue {
                parent.focused.wrappedValue = false
            }
        }

    }
}

enum FeatureComposerTextInputSizing {
    static func height(
        fittingHeight: CGFloat,
        proposedHeight: CGFloat?,
        lineHeight: CGFloat,
        maximumViewportFraction: CGFloat = 0.5
    ) -> CGFloat {
        guard let proposedHeight, proposedHeight.isFinite, proposedHeight > 0 else {
            return min(fittingHeight, lineHeight * 12)
        }
        return min(fittingHeight, proposedHeight * maximumViewportFraction)
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
