import SwiftUI
import UIKit
import UniformTypeIdentifiers
import Observation

/// The composer's text entry is a UIKit text view because SwiftUI's text
/// inputs expose no paste hook on iOS: the long-press Paste menu can never
/// offer an image. Bridging `UITextView` buys the native paste menu, image
/// paste, and internal scrolling once the draft outgrows its viewport cap.
struct FeatureComposerTextInput: UIViewRepresentable {
    @Binding var text: String
    // A plain binding, not `FocusState`: SwiftUI ignores writes to a
    // `FocusState` that no `.focused()` view registers with, and a
    // representable cannot register. The UIKit responder state is the source
    // of truth and this binding mirrors it for the hosts.
    @Binding var focused: Bool
    let placeholder: String
    let acceptsImages: Bool
    let isReadOnly: Bool
    let skills: [FeatureProviderSkill]
    let selectionRequest: FeatureComposerTextSelectionRequest?
    let onSelectionChange: (NSRange) -> Void
    let onPasteImages: ([NSItemProvider]) -> Void
    let onDismissKeyboard: (() -> Void)?

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeUIView(context: Context) -> FeatureComposerUITextView {
        let textView = FeatureComposerUITextView()
        textView.delegate = context.coordinator
        textView.acceptsImages = acceptsImages
        textView.isReadOnly = isReadOnly
        textView.onPasteImages = onPasteImages
        textView.onDismissKeyboard = onDismissKeyboard
        if onDismissKeyboard != nil {
            textView.installDismissPanRecognizer()
        }
        textView.backgroundColor = .clear
        textView.textColor = T3Colors.uiTextPrimary
        textView.tintColor = T3Colors.uiAccent
        textView.font = UIFont.preferredFont(forTextStyle: .body)
        textView.adjustsFontForContentSizeCategory = true
        textView.smartQuotesType = .no
        textView.smartDashesType = .no
        // Outer padding belongs to SwiftUI. The bottom inset keeps the final
        // insertion point above the composer controls.
        textView.configureComposerViewport()
        textView.textContainer.lineFragmentPadding = 0
        textView.isScrollEnabled = true
        // Deliberately not `keyboardDismissMode = .interactive`: the capped
        // input sits directly above the keyboard, so scrolling up through a
        // long draft drags into the keyboard's frame and yanks it around.
        // Dismissal belongs to the pan recognizer below, which only fires
        // for a drag that begins with the draft at its top.
        textView.accessibilityIdentifier = "message-composer"
        updateAccessibility(textView)
        return textView
    }

    func updateUIView(_ textView: FeatureComposerUITextView, context: Context) {
        context.coordinator.parent = self
        textView.acceptsImages = acceptsImages
        textView.onPasteImages = onPasteImages
        textView.onDismissKeyboard = onDismissKeyboard
        textView.isReadOnly = isReadOnly

        let previousAttributedText = textView.attributedText ?? NSAttributedString()
        let previousText = FeatureInlineSkillProjection.plainText(from: previousAttributedText)
        let previousSelection = FeatureInlineSkillProjection.plainRange(
            for: textView.selectedRange,
            in: previousAttributedText
        )
        let shouldApplySelection = selectionRequest.map {
            context.coordinator.lastAppliedSelectionRequestID != $0.id
        } ?? false
        context.coordinator.isApplyingProgrammaticUpdate = true
        defer {
            context.coordinator.isApplyingProgrammaticUpdate = false
            onSelectionChange(FeatureInlineSkillProjection.plainRange(
                for: textView.selectedRange,
                in: textView.attributedText
            ))
        }
        let targetSelection: NSRange
        if shouldApplySelection, let selectionRequest {
            targetSelection = NSRange(
                location: min(selectionRequest.location, text.utf16.count),
                length: 0
            )
        } else if previousText != text {
            let location = FeatureComposerTextSelectionPolicy.cursorLocationAfterBindingUpdate(
                previousText: previousText,
                newText: text,
                selectedLocation: previousSelection.location
            )
            let length = previousText.isEmpty
                ? 0
                : min(previousSelection.length, text.utf16.count - location)
            targetSelection = NSRange(location: location, length: length)
        } else {
            targetSelection = previousSelection
        }

        let rebuiltText = context.coordinator.synchronizeInlineSkills(
            in: textView,
            source: text,
            selection: targetSelection
        )
        if shouldApplySelection, let selectionRequest {
            textView.selectedRange = FeatureInlineSkillProjection.displayRange(
                for: targetSelection,
                in: textView.attributedText
            )
            textView.scrollSelectionIntoView()
            context.coordinator.lastAppliedSelectionRequestID = selectionRequest.id
        } else if rebuiltText {
            textView.scrollSelectionIntoView()
        }
        updateAccessibility(textView)

        if context.coordinator.lastAppliedFocus != focused {
            context.coordinator.lastAppliedFocus = focused
            if focused, !textView.isFirstResponder {
                textView.becomeFirstResponderWhenAttached()
            } else if !focused {
                textView.cancelPendingFirstResponder()
                if textView.isFirstResponder {
                    textView.resignFirstResponder()
                }
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
                lineHeight: uiView.font?.lineHeight ?? 22,
                availableHeight: proposal.height
            )
        )
    }

    private func updateAccessibility(_ textView: FeatureComposerUITextView) {
        textView.accessibilityLabel = "Message agent"
        textView.accessibilityHint = acceptsImages
            ? "Enter a message or paste images"
            : "Enter a message"
        textView.accessibilityValue = text.isEmpty ? placeholder : text
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        private struct UndoSnapshot: Equatable {
            let source: String
            let selection: NSRange
        }

        var parent: FeatureComposerTextInput
        var lastAppliedFocus: Bool?
        var lastAppliedSelectionRequestID: UUID?
        var isApplyingProgrammaticUpdate = false
        private var isSynchronizingInlineSkills = false
        private var pendingUndoSnapshot: UndoSnapshot?
        private weak var disabledUndoManager: UndoManager?

        init(_ parent: FeatureComposerTextInput) {
            self.parent = parent
        }

        func textView(
            _ textView: UITextView,
            shouldChangeTextIn range: NSRange,
            replacementText text: String
        ) -> Bool {
            guard !parent.isReadOnly else { return false }
            guard !isApplyingProgrammaticUpdate, !isSynchronizingInlineSkills else {
                return true
            }
            if pendingUndoSnapshot == nil {
                pendingUndoSnapshot = undoSnapshot(in: textView)
            }
            if disabledUndoManager == nil,
               let undoManager = textView.undoManager,
               undoManager.isUndoRegistrationEnabled {
                undoManager.disableUndoRegistration()
                disabledUndoManager = undoManager
            }
            return true
        }

        func textViewDidChange(_ textView: UITextView) {
            restoreUndoRegistration()
            guard !isApplyingProgrammaticUpdate else { return }
            guard !isSynchronizingInlineSkills else { return }
            let source = FeatureInlineSkillProjection.plainText(from: textView.attributedText)
            if parent.text != source {
                parent.text = source
            }
            guard textView.markedTextRange == nil,
                  let composerTextView = textView as? FeatureComposerUITextView else {
                return
            }
            let selection = FeatureInlineSkillProjection.plainRange(
                for: textView.selectedRange,
                in: textView.attributedText
            )
            _ = synchronizeInlineSkills(
                in: composerTextView,
                source: source,
                selection: selection
            )
            let updatedSnapshot = UndoSnapshot(source: source, selection: selection)
            if let pendingUndoSnapshot, pendingUndoSnapshot != updatedSnapshot {
                registerUndo(
                    restoring: pendingUndoSnapshot,
                    inverse: updatedSnapshot,
                    in: composerTextView
                )
            }
            pendingUndoSnapshot = nil
            composerTextView.scrollSelectionIntoView()
        }

        @discardableResult
        func synchronizeInlineSkills(
            in textView: FeatureComposerUITextView,
            source: String,
            selection: NSRange
        ) -> Bool {
            let currentText = textView.attributedText ?? NSAttributedString()
            let currentSource = FeatureInlineSkillProjection.plainText(from: currentText)
            let currentSignatures = FeatureInlineSkillProjection.signatures(in: currentText)
            let preservedTrailing = currentSource == source
                ? currentSignatures.last?.descriptor
                : nil
            let descriptors = FeatureInlineSkillParser.descriptors(
                in: source,
                skills: parent.skills,
                allowsEndBoundary: false,
                preservingTrailing: preservedTrailing
            )
            let font = textView.font ?? UIFont.preferredFont(forTextStyle: .body)
            let desiredSignatures = FeatureInlineSkillPillRenderer.signatures(
                for: descriptors,
                font: font,
                traits: textView.traitCollection
            )
            guard currentSource != source || currentSignatures != desiredSignatures else {
                return false
            }

            let baseAttributes: [NSAttributedString.Key: Any] = [
                .font: font,
                .foregroundColor: T3Colors.uiTextPrimary,
            ]
            let attributedText = FeatureInlineSkillPillRenderer.attributedText(
                source: source,
                descriptors: descriptors,
                baseAttributes: baseAttributes,
                font: font,
                traits: textView.traitCollection
            )
            isSynchronizingInlineSkills = true
            textView.attributedText = attributedText
            textView.selectedRange = FeatureInlineSkillProjection.displayRange(
                for: selection,
                in: attributedText
            )
            textView.typingAttributes = baseAttributes
            isSynchronizingInlineSkills = false
            return true
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            guard !isApplyingProgrammaticUpdate, !isSynchronizingInlineSkills else { return }
            let selection = FeatureInlineSkillProjection.plainRange(
                for: textView.selectedRange,
                in: textView.attributedText
            )
            parent.onSelectionChange(selection)
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            lastAppliedFocus = true
            if !parent.focused {
                parent.focused = true
            }
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            restoreUndoRegistration()
            pendingUndoSnapshot = nil
            lastAppliedFocus = false
            if parent.focused {
                parent.focused = false
            }
        }

        private func undoSnapshot(in textView: UITextView) -> UndoSnapshot {
            UndoSnapshot(
                source: FeatureInlineSkillProjection.plainText(from: textView.attributedText),
                selection: FeatureInlineSkillProjection.plainRange(
                    for: textView.selectedRange,
                    in: textView.attributedText
                )
            )
        }

        private func restoreUndoRegistration() {
            if let disabledUndoManager,
               !disabledUndoManager.isUndoRegistrationEnabled {
                disabledUndoManager.enableUndoRegistration()
            }
            disabledUndoManager = nil
        }

        private func registerUndo(
            restoring snapshot: UndoSnapshot,
            inverse: UndoSnapshot,
            in textView: FeatureComposerUITextView
        ) {
            guard let undoManager = textView.undoManager else { return }
            let opensUndoGroup = undoManager.groupingLevel == 0
            if opensUndoGroup {
                undoManager.beginUndoGrouping()
            }
            undoManager.registerUndo(withTarget: self) { [weak textView] coordinator in
                guard let textView else { return }
                coordinator.restore(
                    snapshot,
                    inverse: inverse,
                    in: textView
                )
            }
            undoManager.setActionName("Typing")
            if opensUndoGroup {
                undoManager.endUndoGrouping()
            }
        }

        private func restore(
            _ snapshot: UndoSnapshot,
            inverse: UndoSnapshot,
            in textView: FeatureComposerUITextView
        ) {
            registerUndo(restoring: inverse, inverse: snapshot, in: textView)
            isApplyingProgrammaticUpdate = true
            _ = synchronizeInlineSkills(
                in: textView,
                source: snapshot.source,
                selection: snapshot.selection
            )
            parent.text = snapshot.source
            parent.onSelectionChange(snapshot.selection)
            isApplyingProgrammaticUpdate = false
            textView.scrollSelectionIntoView()
        }
    }
}

/// Advertises image support to the paste menu and routes image pastes out to
/// the attachment pipeline. Text-only pastes fall through to UIKit untouched.
final class FeatureComposerUITextView: FeatureInlineSkillTextView {
    private static let bottomEditingInset: CGFloat = 10
    private var lastLaidOutBoundsSize = CGSize.zero

    // Changing isEditable can dismiss an open keyboard. During voice input,
    // keep the responder and reject user edits without changing isEditable.
    var isReadOnly = false

    override var canBecomeFirstResponder: Bool {
        (!isReadOnly || isFirstResponder) && super.canBecomeFirstResponder
    }

    override func insertText(_ text: String) {
        guard !isReadOnly else { return }
        super.insertText(text)
    }

    override func deleteBackward() {
        guard !isReadOnly else { return }
        super.deleteBackward()
    }

    override func cut(_ sender: Any?) {
        guard !isReadOnly else { return }
        super.cut(sender)
    }

    func configureComposerViewport() {
        clipsToBounds = true
        textContainerInset = UIEdgeInsets(
            top: 0,
            left: 0,
            bottom: Self.bottomEditingInset,
            right: 0
        )
    }

    func scrollSelectionIntoView() {
        guard bounds.width > 0, bounds.height > 0 else { return }
        scrollRangeToVisible(selectedRange)
        guard let selection = selectedTextRange else { return }

        let caret = caretRect(for: selection.end)
        let visibleBottom = contentOffset.y + bounds.height - Self.bottomEditingInset
        guard caret.maxY > visibleBottom else { return }

        let maximumOffset = max(
            -adjustedContentInset.top,
            contentSize.height + adjustedContentInset.bottom - bounds.height
        )
        let requestedOffset = caret.maxY + Self.bottomEditingInset - bounds.height
        let pixelScale = traitCollection.displayScale > 0 ? traitCollection.displayScale : 1
        let alignedOffset = ceil(requestedOffset * pixelScale) / pixelScale
        setContentOffset(
            CGPoint(x: contentOffset.x, y: min(maximumOffset, alignedOffset)),
            animated: false
        )
    }

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
    var onDismissKeyboard: (() -> Void)?
    private var wantsFirstResponderOnAttach = false

    /// Programmatic focus can arrive before the view joins a window (a host
    /// refocusing right as the composer expands); retry once attached. The
    /// pending request is cancelled if focus clears again before the view
    /// attaches, so a stale request can never raise the keyboard.
    func becomeFirstResponderWhenAttached() {
        if window != nil {
            becomeFirstResponder()
        } else {
            wantsFirstResponderOnAttach = true
        }
    }

    func cancelPendingFirstResponder() {
        wantsFirstResponderOnAttach = false
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil, wantsFirstResponderOnAttach {
            wantsFirstResponderOnAttach = false
            becomeFirstResponder()
        }
    }

    // A SwiftUI drag gesture on the composer never sees drags that start
    // inside this view: the text interaction's own recognizers claim them at
    // the UIKit level. This observing pan reproduces the host's
    // drag-to-dismiss there: it recognizes alongside everything, cancels
    // nothing, and dismisses a scrollable draft only when the drag begins at
    // its top.
    private let dismissPanDelegate = FeatureComposerDismissPanDelegate()

    func installDismissPanRecognizer() {
        let pan = UIPanGestureRecognizer(target: self, action: #selector(handleDismissPan))
        pan.cancelsTouchesInView = false
        pan.delegate = dismissPanDelegate
        addGestureRecognizer(pan)
    }

    private var dismissPanBeganAtTop = false

    @objc private func handleDismissPan(_ recognizer: UIPanGestureRecognizer) {
        // A fast flick can jump straight from .began to .ended without a
        // .changed in between, so the end state is evaluated too. The at-top
        // check is latched at .began: a drag that merely reaches the top
        // mid-scroll only rubber-bands, instead of yanking the keyboard away
        // the moment the offset crosses zero.
        switch recognizer.state {
        case .began:
            dismissPanBeganAtTop = contentOffset.y <= 0
            return
        case .changed, .ended: break
        default: return
        }
        guard isFirstResponder else { return }
        let translation = recognizer.translation(in: self)
        guard FeatureComposerDragDismissPolicy.shouldDismiss(
            translationX: translation.x,
            translationY: translation.y,
            isScrollable: contentOverflows,
            isAtTop: dismissPanBeganAtTop
        ) else { return }
        onDismissKeyboard?()
    }

    // Scrolling stays enabled at every size: toggling `isScrollEnabled` off
    // stops UITextView from maintaining `contentSize` on some OS versions,
    // which left long drafts unscrollable on device. Overflow is computed
    // fresh wherever it matters instead. A stale offset from a mid-resize
    // selection change is still reset; with nothing to scroll, any offset
    // clips the first line under the padding.
    var contentOverflows: Bool {
        contentSize.height > bounds.height + 0.5
    }

    override func layoutSubviews() {
        let viewportChanged = lastLaidOutBoundsSize != bounds.size
        lastLaidOutBoundsSize = bounds.size
        super.layoutSubviews()
        if !contentOverflows, contentOffset.y != 0 {
            contentOffset.y = 0
        } else if viewportChanged, isFirstResponder {
            // `sizeThatFits` receives a proposal. The final UIKit viewport can
            // still differ after the footer and attachments take their space.
            // Recheck the caret against these actual bounds once per resize.
            scrollSelectionIntoView()
        }
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if isReadOnly, action == #selector(paste(_:)) || action == #selector(cut(_:)) {
            return false
        }
        if action == #selector(paste(_:)),
           acceptsImages,
           FeatureComposerPasteboardPolicy.containsImage(in: UIPasteboard.general) {
            return true
        }
        return super.canPerformAction(action, withSender: sender)
    }

    // Drops are the other client of the paste configuration: while editing,
    // UIKit offers the text view any drag it says it can paste. Declining
    // image drags leaves them to the composer surface, so one target owns
    // the session and the highlight; when the text view wins instead, the
    // image vanishes into UITextView's text-only default and the surface's
    // highlight never hears that the session ended.
    override func canPaste(_ itemProviders: [NSItemProvider]) -> Bool {
        guard !isReadOnly else { return false }
        let holdsImage = itemProviders.contains {
            $0.hasItemConformingToTypeIdentifier(UTType.image.identifier)
        }
        return holdsImage ? false : super.canPaste(itemProviders)
    }

    // When the pasteboard holds images, only the images attach. Any text
    // riding along (a copied web image usually brings its URL) is dropped on
    // purpose: Slack and X do the same, and inserting a stray URL next to an
    // attached screenshot reads as a bug.
    override func paste(_ sender: Any?) {
        guard !isReadOnly else { return }
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
        onPasteImages?(imageProviders)
    }
}

/// A standalone delegate (rather than the text view itself, whose scroll-view
/// superclass already takes part in gesture delegation) so the observing pan
/// reliably recognizes alongside the text interaction's own recognizers
/// instead of being cancelled by them.
private final class FeatureComposerDismissPanDelegate: NSObject, UIGestureRecognizerDelegate {
    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        true
    }
}

/// Mirrors the thread view's composer drag-to-dismiss thresholds: a clearly
/// vertical downward drag. While the draft is scrollable, scrolling back
/// through it never drops the keyboard mid-read, but a drag that *begins*
/// with the draft at its top only rubber-bands, which is unambiguous
/// dismissal intent (and the composer's only escape hatch once it and the
/// keyboard cover the transcript). `isAtTop` is the position at drag start,
/// so a scroll that reaches the top never dismisses mid-gesture.
enum FeatureComposerDragDismissPolicy {
    static func shouldDismiss(
        translationX: CGFloat,
        translationY: CGFloat,
        isScrollable: Bool,
        isAtTop: Bool
    ) -> Bool {
        (!isScrollable || isAtTop)
            && translationY > 8
            && translationY > abs(translationX)
    }
}

enum FeatureComposerPasteboardPolicy {
    /// `UIPasteboard.hasImages` misses formats that merely conform to image
    /// (HEIC screenshots among them), so detection goes through UTType
    /// conformance instead.
    static func containsImage(in pasteboard: UIPasteboard) -> Bool {
        pasteboard.itemProviders.contains {
            $0.hasItemConformingToTypeIdentifier(UTType.image.identifier)
        }
    }
}

/// A one-shot caret placement, applied by the text input exactly once per
/// request `id`. Command completion issues one so the caret lands after the
/// inserted text instead of wherever UIKit leaves it after a programmatic
/// text replacement.
struct FeatureComposerTextSelectionRequest: Equatable {
    let id = UUID()
    let location: Int
}

/// Selection changes come from `updateUIView` and UIKit delegate callbacks.
/// Keeping this value outside Observation avoids synchronous SwiftUI state
/// writes while the representable is updating.
@MainActor
@Observable
final class FeatureComposerTextObservation {
    @ObservationIgnored var selection = NSRange(location: 0, length: 0)
}

enum FeatureComposerTextSelectionPolicy {
    /// UTF-16 caret location after `range` (character indices, as produced by
    /// the trigger parser) is replaced with `replacement`.
    static func cursorLocation(
        afterReplacing range: Range<Int>,
        in text: String,
        with replacement: String
    ) -> Int {
        let lower = min(max(range.lowerBound, 0), text.count)
        let lowerIndex = text.index(text.startIndex, offsetBy: lower)
        return text[..<lowerIndex].utf16.count + replacement.utf16.count
    }

    /// Caret location after the binding changed underneath the text view. A
    /// restored draft (previous text empty) puts the caret at the end; any
    /// other external rewrite keeps the caret where it was, clamped into the
    /// new text.
    static func cursorLocationAfterBindingUpdate(
        previousText: String,
        newText: String,
        selectedLocation: Int
    ) -> Int {
        previousText.isEmpty ? newText.utf16.count : min(selectedLocation, newText.utf16.count)
    }
}

/// The editor grows with its content, then scrolls when it reaches the line
/// cap or the space above the composer controls. A finite SwiftUI proposal is
/// a hard bound. Returning a larger minimum makes the parent clip the editor
/// under its fixed footer.
enum FeatureComposerTextInputSizing {
    static let maximumLines: CGFloat = 12

    static func height(
        fittingHeight: CGFloat,
        lineHeight: CGFloat,
        availableHeight: CGFloat? = nil
    ) -> CGFloat {
        let maximumHeight = max(0, lineHeight * maximumLines)
        let contentHeight = max(0, fittingHeight)
        guard let availableHeight, availableHeight.isFinite else {
            return min(contentHeight, maximumHeight)
        }
        return min(contentHeight, maximumHeight, max(0, availableHeight))
    }
}
