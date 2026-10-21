import ExpoModulesCore
import UIKit

private struct ComposerTokenPayload: Decodable {
  let type: String
  let source: String
  let label: String
  let iconUri: String?
  let accent: String?
  let tintsIcon: Bool?
  let detail: String?
  let start: Int
  let end: Int
}

private struct ComposerSelectionPayload: Decodable {
  let start: Int
  let end: Int
}

private struct ComposerControlledDocumentPayload: Decodable {
  let value: String
  let selection: ComposerSelectionPayload?
  let tokensJson: String
  let mostRecentEventCount: Int
  let isNativeEcho: Bool
}

private struct ComposerThemePayload: Decodable {
  let text: String
  let placeholder: String
}

private enum ComposerEnterBehavior: String {
  case send
  case newline
}

private final class ComposerTextAttachment: NSTextAttachment {
  let source: String
  let label: String

  init(source: String, label: String, image: UIImage, size: CGSize, baselineOffset: CGFloat) {
    self.source = source
    self.label = label
    super.init(data: nil, ofType: nil)
    self.image = image
    bounds = CGRect(x: 0, y: baselineOffset, width: size.width, height: size.height)
  }

  required init?(coder: NSCoder) {
    nil
  }
}

private final class ComposerContextAccessibilityElement: UIAccessibilityElement {
  var activate: (() -> Bool)?

  override func accessibilityActivate() -> Bool {
    activate?() ?? false
  }
}

private final class ComposerTextView: UITextView {
  private static let pastedImageDirectoryName = "t3-composer-paste"
  private static let stalePastedImageAge: TimeInterval = 60 * 60
  private static let readOnlyActions = Set([
    "cut:",
    "delete:",
    "paste:",
    "redo:",
    "toggleBoldface:",
    "toggleItalics:",
    "toggleUnderline:",
    "undo:",
  ])

  var onPasteImages: (([String]) -> Void)?
  var onPasteContext: (([String: String]) -> Void)?
  var onPasteText: ((String, NSRange) -> Void)?
  var clipboardFragment = ""
  var onAttributedMutation: (() -> Void)?
  var onSubmit: ((Bool) -> Void)?
  var isReadOnly = false
  var textPasteThresholdBytes = 0
  var maxInputChars = Int.max
  var enterBehavior: ComposerEnterBehavior = .send
  /// JS supplies the actual send outcomes so the iPad Command-hold HUD names the configured actions.
  var submitTitle = "Send Message"
  var alternateSubmitTitle = "Send Message"
  private var bypassTextPasteInterception = false

  override var keyCommands: [UIKeyCommand]? {
    var commands = super.keyCommands ?? []
    guard !isReadOnly, markedTextRange == nil else { return commands }
    if enterBehavior == .send {
      let submitOnReturn = UIKeyCommand(
        input: "\r",
        modifierFlags: [],
        action: #selector(submitMessage(_:))
      )
      submitOnReturn.discoverabilityTitle = submitTitle
      submitOnReturn.wantsPriorityOverSystemBehavior = true
      commands.append(submitOnReturn)

      let submitAlternate = UIKeyCommand(
        input: "\r",
        modifierFlags: .command,
        action: #selector(submitMessageAlternate(_:))
      )
      submitAlternate.discoverabilityTitle = alternateSubmitTitle
      submitAlternate.wantsPriorityOverSystemBehavior = true
      commands.append(submitAlternate)

      let newline = UIKeyCommand(
        input: "\r",
        modifierFlags: .shift,
        action: #selector(insertNewline(_:))
      )
      newline.discoverabilityTitle = "New Line"
      newline.wantsPriorityOverSystemBehavior = true
      commands.append(newline)
    } else {
      let submit = UIKeyCommand(
        input: "\r",
        modifierFlags: .command,
        action: #selector(submitMessage(_:))
      )
      submit.discoverabilityTitle = submitTitle
      submit.wantsPriorityOverSystemBehavior = true
      commands.append(submit)

      let submitAlternate = UIKeyCommand(
        input: "\r",
        modifierFlags: [.command, .shift],
        action: #selector(submitMessageAlternate(_:))
      )
      submitAlternate.discoverabilityTitle = alternateSubmitTitle
      submitAlternate.wantsPriorityOverSystemBehavior = true
      commands.append(submitAlternate)
    }
    if textPasteThresholdBytes > 0 {
      let pasteAsText = UIKeyCommand(
        input: "v",
        modifierFlags: [.command, .shift],
        action: #selector(pasteInline(_:))
      )
      pasteAsText.discoverabilityTitle = "Paste as Text"
      pasteAsText.wantsPriorityOverSystemBehavior = true
      commands.append(pasteAsText)
    }
    return commands
  }

  @objc private func submitMessage(_ sender: UIKeyCommand) {
    guard !isReadOnly, markedTextRange == nil else { return }
    onSubmit?(false)
  }

  @objc private func submitMessageAlternate(_ sender: UIKeyCommand) {
    guard !isReadOnly, markedTextRange == nil else { return }
    onSubmit?(true)
  }

  @objc private func insertNewline(_ sender: UIKeyCommand) {
    guard !isReadOnly, markedTextRange == nil else { return }
    insertText("\n")
  }

  @objc private func pasteInline(_ sender: UIKeyCommand) {
    guard !isReadOnly else {
      return
    }
    bypassTextPasteInterception = true
    defer { bypassTextPasteInterception = false }
    paste(sender)
  }

  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if action == #selector(submitMessage(_:)) || action == #selector(insertNewline(_:)) {
      return isEditable && !isReadOnly && markedTextRange == nil
    }
    if isReadOnly && Self.readOnlyActions.contains(NSStringFromSelector(action)) {
      return false
    }
    if action == #selector(paste(_:)) {
      let pasteboard = UIPasteboard.general
      if pasteboard.hasImages ||
        pasteboard.itemProviders.contains(where: {
          $0.canLoadObject(ofClass: UIImage.self)
        }) {
        return true
      }
    }
    return super.canPerformAction(action, withSender: sender)
  }

  override func paste(_ sender: Any?) {
    guard !isReadOnly else {
      return
    }
    let pasteboard = UIPasteboard.general
    let context = T3ComposerClipboard.read()
    if !context["fragment", default: ""].isEmpty || context["html", default: ""].contains("data-t3-context-fragment=") {
      onPasteContext?(context)
      return
    }
    let imageProviders = pasteboard.itemProviders.filter {
      $0.canLoadObject(ofClass: UIImage.self)
    }
    if !imageProviders.isEmpty {
      loadImages(from: imageProviders)
      return
    }

    let images = pasteboard.images ?? []
    if !images.isEmpty {
      let urls = images.compactMap(Self.writeTemporaryImage)
      if !urls.isEmpty {
        onPasteImages?(urls)
        return
      }
    }
    if !bypassTextPasteInterception,
       let text = pasteboard.string, shouldInterceptTextPaste(text) {
      onPasteText?(text, selectedRange)
      return
    }
    super.paste(sender)
  }

  private func shouldInterceptTextPaste(_ text: String) -> Bool {
    guard textPasteThresholdBytes > 0, !text.isEmpty else { return false }
    let pastedLength = (text as NSString).length
    if pastedLength >= textPasteThresholdBytes || text.utf8.count >= textPasteThresholdBytes {
      return true
    }
    // Chips occupy one display character but expand to their source in the
    // submitted message. Measure that source, including the replaced selection.
    let sourceLength = sourceOffset(forDisplayOffset: attributedText.length)
    let selectedLength = sourceOffset(forDisplayOffset: NSMaxRange(selectedRange)) -
      sourceOffset(forDisplayOffset: selectedRange.location)
    return sourceLength - selectedLength + pastedLength > maxInputChars
  }

  override func deleteBackward() {
    guard !isReadOnly else {
      return
    }
    guard selectedRange.length == 0, selectedRange.location > 0 else {
      super.deleteBackward()
      return
    }

    let previousOffset = selectedRange.location - 1
    if textStorage.attribute(.attachment, at: previousOffset, effectiveRange: nil)
      is ComposerTextAttachment {
      replaceDisplayRange(NSRange(location: previousOffset, length: 1))
      return
    }

    super.deleteBackward()
  }

  private func replaceDisplayRange(_ range: NSRange) {
    guard let start = position(from: beginningOfDocument, offset: range.location),
          let end = position(from: start, offset: range.length),
          let textRange = textRange(from: start, to: end) else {
      return
    }
    replace(textRange, withText: "")
  }

  func loadImages(from providers: [NSItemProvider]) {
    let group = DispatchGroup()
    let lock = NSLock()
    var images = [UIImage?](repeating: nil, count: providers.count)

    for (index, provider) in providers.enumerated() {
      group.enter()
      provider.loadObject(ofClass: UIImage.self) { object, _ in
        defer { group.leave() }
        guard let image = object as? UIImage else {
          return
        }
        lock.lock()
        images[index] = image
        lock.unlock()
      }
    }

    group.notify(queue: .main) { [weak self] in
      guard let self, !self.isReadOnly else {
        return
      }
      let urls = images.compactMap { $0 }.compactMap(Self.writeTemporaryImage)
      if !urls.isEmpty {
        self.onPasteImages?(urls)
      }
    }
  }

  override func copy(_ sender: Any?) {
    guard selectedRange.length > 0 else {
      return super.copy(sender)
    }
    T3ComposerClipboard.write(text: serializedText(in: selectedRange), fragment: clipboardFragment)
  }

  override func cut(_ sender: Any?) {
    guard !isReadOnly else {
      return
    }
    guard isEditable, selectedRange.length > 0 else {
      return super.cut(sender)
    }
    copy(sender)
    textStorage.replaceCharacters(in: selectedRange, with: "")
    selectedRange = NSRange(location: selectedRange.location, length: 0)
    onAttributedMutation?()
  }

  func serializedText() -> String {
    serializedText(in: NSRange(location: 0, length: attributedText.length))
  }

  func serializedText(in range: NSRange) -> String {
    guard range.length > 0 else {
      return ""
    }

    let source = NSMutableString()
    let nsString = attributedText.string as NSString
    var cursor = range.location
    let end = NSMaxRange(range)
    attributedText.enumerateAttribute(.attachment, in: range) { value, attachmentRange, _ in
      if attachmentRange.location > cursor {
        source.append(
          nsString.substring(
            with: NSRange(location: cursor, length: attachmentRange.location - cursor)
          )
        )
      }
      if let attachment = value as? ComposerTextAttachment {
        source.append(attachment.source)
      } else {
        source.append(nsString.substring(with: attachmentRange))
      }
      cursor = NSMaxRange(attachmentRange)
    }
    if cursor < end {
      source.append(nsString.substring(with: NSRange(location: cursor, length: end - cursor)))
    }
    return source as String
  }

  func sourceOffset(forDisplayOffset displayOffset: Int) -> Int {
    let boundedOffset = max(0, min(attributedText.length, displayOffset))
    if boundedOffset == 0 {
      return 0
    }

    var sourceOffset = 0
    let range = NSRange(location: 0, length: boundedOffset)
    attributedText.enumerateAttribute(.attachment, in: range) { value, attributeRange, _ in
      if let attachment = value as? ComposerTextAttachment {
        sourceOffset += (attachment.source as NSString).length
      } else {
        sourceOffset += attributeRange.length
      }
    }
    return sourceOffset
  }

  private static func writeTemporaryImage(_ image: UIImage) -> String? {
    guard let data = image.pngData() else {
      return nil
    }
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(pastedImageDirectoryName, isDirectory: true)
    do {
      try FileManager.default.createDirectory(
        at: directory,
        withIntermediateDirectories: true
      )
      removeStaleTemporaryImages(in: directory)
      let url = directory.appendingPathComponent("\(UUID().uuidString).png")
      try data.write(to: url, options: .atomic)
      return url.absoluteString
    } catch {
      return nil
    }
  }

  private static func removeStaleTemporaryImages(in directory: URL) {
    let cutoff = Date().addingTimeInterval(-stalePastedImageAge)
    guard let urls = try? FileManager.default.contentsOfDirectory(
      at: directory,
      includingPropertiesForKeys: [.contentModificationDateKey, .isRegularFileKey],
      options: [.skipsHiddenFiles]
    ) else {
      return
    }

    for url in urls {
      guard
        let values = try? url.resourceValues(
          forKeys: [.contentModificationDateKey, .isRegularFileKey]
        ),
        values.isRegularFile == true,
        let modifiedAt = values.contentModificationDate,
        modifiedAt < cutoff
      else {
        continue
      }
      try? FileManager.default.removeItem(at: url)
    }
  }
}

public final class T3ComposerEditorView: ExpoView, UITextViewDelegate, UITextDropDelegate, UIGestureRecognizerDelegate {
  private let textView = ComposerTextView()
  private let placeholderLabel = UILabel()
  private var value = ""
  private var tokensJson = "[]"
  private var tokens: [ComposerTokenPayload] = []
  private var requestedSelection: ComposerSelectionPayload?
  private var theme = ComposerThemePayload(
    text: "#262626",
    placeholder: "#8e8e93"
  )
  private var fontFamily = "DMSans-Regular"
  private var fontSize: CGFloat = 14
  private var lineHeight: CGFloat = 20
  private var contentInsetVertical: CGFloat = 0
  private var shouldAutoFocus = false
  private var didAutoFocus = false
  private var isReadOnly = false
  private var isApplyingControlledValue = false
  private var nativeEventCount = 0
  private var lastContentSize = CGSize.zero
  private var iconImages: [String: UIImage] = [:]
  private var pendingIconUris = Set<String>()
  private var tokensNeedRebuild = false
  private var chipsNeedMeasuredWidth = false
  private var hasDeferredForcedRebuild = false

  let onComposerChange = EventDispatcher()
  let onComposerSelectionChange = EventDispatcher()
  let onComposerFocus = EventDispatcher()
  let onComposerBlur = EventDispatcher()
  let onComposerSubmit = EventDispatcher()
  let onComposerPasteImages = EventDispatcher()
  let onComposerContextPress = EventDispatcher()
  let onComposerPasteContext = EventDispatcher()
  let onComposerPasteText = EventDispatcher()
  let onComposerContentSizeChange = EventDispatcher()

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)

    clipsToBounds = false
    textView.delegate = self
    textView.textDropDelegate = self
    textView.backgroundColor = .clear
    textView.textContainerInset = .zero
    textView.textContainer.lineFragmentPadding = 0
    textView.keyboardDismissMode = .interactive
    textView.alwaysBounceVertical = false
    textView.showsVerticalScrollIndicator = true
    textView.adjustsFontForContentSizeCategory = true
    textView.onPasteImages = { [weak self] urls in
      self?.onComposerPasteImages(["uris": urls])
    }
    textView.onPasteContext = { [weak self] context in
      guard let self else { return }
      let selection = self.sourceSelection()
      self.nativeEventCount += 1
      var payload: [String: Any] = context
      payload["value"] = self.textView.serializedText()
      payload["eventCount"] = self.nativeEventCount
      payload["selection"] = ["start": selection.start, "end": selection.end]
      self.onComposerPasteContext(payload)
    }
    textView.onPasteText = { [weak self] text, _ in
      guard let self else { return }
      let selection = self.sourceSelection()
      self.nativeEventCount += 1
      self.onComposerPasteText([
        "value": self.textView.serializedText(),
        "eventCount": self.nativeEventCount,
        "text": text,
        "selection": ["start": selection.start, "end": selection.end],
      ])
    }
    textView.onAttributedMutation = { [weak self] in
      self?.emitTextChange()
    }
    textView.onSubmit = { [weak self] alternate in
      self?.onComposerSubmit(["alternate": alternate])
    }
    let contextTap = UITapGestureRecognizer(target: self, action: #selector(openContext(_:)))
    contextTap.cancelsTouchesInView = false
    contextTap.delegate = self
    textView.addGestureRecognizer(contextTap)
    addSubview(textView)

    placeholderLabel.numberOfLines = 0
    placeholderLabel.adjustsFontForContentSizeCategory = true
    addSubview(placeholderLabel)
    applyTypography()
    applyTheme()
  }

  @objc private func openContext(_ recognizer: UITapGestureRecognizer) {
    guard let (index, attachment) = contextAttachment(at: recognizer.location(in: textView)) else {
      textView.becomeFirstResponder()
      return
    }
    openContext(index: index, attachment: attachment)
  }

  private func openContext(index: Int, attachment: ComposerTextAttachment) {
    let start = textView.sourceOffset(forDisplayOffset: index)
    onComposerContextPress(["source": attachment.source, "start": start, "end": start + (attachment.source as NSString).length])
  }

  public override var accessibilityElements: [Any]? {
    get {
      var elements: [Any] = [textView]
      let layout = textView.layoutManager
      textView.textStorage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: textView.textStorage.length)) { value, range, _ in
        guard let attachment = value as? ComposerTextAttachment else { return }
        let glyphRange = layout.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        let rect = layout.boundingRect(forGlyphRange: glyphRange, in: textView.textContainer)
          .offsetBy(dx: textView.textContainerInset.left, dy: textView.textContainerInset.top)
        guard rect.intersects(textView.bounds) else { return }
        let element = ComposerContextAccessibilityElement(accessibilityContainer: self)
        element.accessibilityLabel = attachment.label
        element.accessibilityTraits = .button
        element.accessibilityFrameInContainerSpace = textView.convert(rect, to: self)
        element.activate = { [weak self] in
          guard let self, range.location < self.textView.textStorage.length,
                self.textView.textStorage.attribute(.attachment, at: range.location, effectiveRange: nil) as? ComposerTextAttachment === attachment else { return false }
          self.openContext(index: range.location, attachment: attachment)
          return true
        }
        elements.append(element)
      }
      return elements
    }
    set { super.accessibilityElements = newValue }
  }

  public func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
    true
  }

  public func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
    true
  }

  public func textView(_ textView: UITextView, shouldInteractWith textAttachment: NSTextAttachment, in characterRange: NSRange, interaction: UITextItemInteraction) -> Bool {
    // A chip is text context, not an image to save to the camera roll.
    !(textAttachment is ComposerTextAttachment)
  }

  private func contextAttachment(at point: CGPoint) -> (Int, ComposerTextAttachment)? {
    let containerPoint = CGPoint(x: point.x - textView.textContainerInset.left, y: point.y - textView.textContainerInset.top)
    let layout = textView.layoutManager
    let index = layout.characterIndex(for: containerPoint, in: textView.textContainer, fractionOfDistanceBetweenInsertionPoints: nil)
    guard index < textView.textStorage.length,
          let attachment = textView.textStorage.attribute(.attachment, at: index, effectiveRange: nil) as? ComposerTextAttachment else { return nil }
    let glyphRange = layout.glyphRange(forCharacterRange: NSRange(location: index, length: 1), actualCharacterRange: nil)
    guard layout.boundingRect(forGlyphRange: glyphRange, in: textView.textContainer).contains(containerPoint) else { return nil }
    return (index, attachment)
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    textView.frame = bounds
    if chipsNeedMeasuredWidth, bounds.width > 0 {
      chipsNeedMeasuredWidth = false
      applyControlledDocument(force: true)
    }
    let placeholderX = textView.textContainerInset.left + textView.textContainer.lineFragmentPadding
    let placeholderY = textView.textContainerInset.top
    let placeholderWidth = max(
      0,
      bounds.width - placeholderX - textView.textContainerInset.right -
        textView.textContainer.lineFragmentPadding
    )
    placeholderLabel.frame = CGRect(
      x: placeholderX,
      y: placeholderY,
      width: placeholderWidth,
      height: max(lineHeight, placeholderLabel.font.lineHeight)
    )
    emitContentSizeIfNeeded()
  }

  func setClipboardFragment(_ fragment: String) {
    textView.clipboardFragment = fragment
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    guard window != nil, shouldAutoFocus, !didAutoFocus else {
      return
    }
    didAutoFocus = true
    DispatchQueue.main.async { [weak self] in
      self?.textView.becomeFirstResponder()
    }
  }

  func setControlledDocumentJson(_ documentJson: String) {
    guard let document = decode(ComposerControlledDocumentPayload.self, from: documentJson),
          document.mostRecentEventCount >= nativeEventCount else {
      return
    }
    if document.isNativeEcho && textView.serializedText() != document.value {
      return
    }
    if tokensJson != document.tokensJson {
      tokensJson = document.tokensJson
      tokens = decode([ComposerTokenPayload].self, from: document.tokensJson) ?? []
      tokensNeedRebuild = true
    }
    value = document.value
    requestedSelection = document.selection
    applyControlledDocument(force: tokensNeedRebuild)
    applyRequestedSelection()
    if tokensMatchCurrentValue() {
      tokensNeedRebuild = false
    }
  }

  func setThemeJson(_ themeJson: String) {
    guard let nextTheme = decode(ComposerThemePayload.self, from: themeJson) else {
      return
    }
    theme = nextTheme
    applyTheme()
    applyControlledDocument(force: true)
  }

  func setPlaceholder(_ placeholder: String) {
    placeholderLabel.text = placeholder
    setNeedsLayout()
  }

  func setFontFamily(_ fontFamily: String) {
    self.fontFamily = fontFamily
    applyTypography()
    applyControlledDocument(force: true)
  }

  func setFontSize(_ fontSize: CGFloat) {
    self.fontSize = fontSize
    applyTypography()
    applyControlledDocument(force: true)
  }

  func setLineHeight(_ lineHeight: CGFloat) {
    self.lineHeight = lineHeight
    applyTypography()
    applyControlledDocument(force: true)
  }

  func setContentInsetVertical(_ contentInsetVertical: CGFloat) {
    self.contentInsetVertical = contentInsetVertical
    textView.textContainerInset = UIEdgeInsets(
      top: contentInsetVertical,
      left: 0,
      bottom: contentInsetVertical,
      right: 0
    )
    setNeedsLayout()
  }

  func setEditable(_ editable: Bool) {
    textView.isEditable = editable
  }

  func setReadOnly(_ readOnly: Bool) {
    isReadOnly = readOnly
    textView.isReadOnly = readOnly
  }

  func setScrollEnabled(_ scrollEnabled: Bool) {
    textView.isScrollEnabled = scrollEnabled
  }

  func setAutoFocus(_ autoFocus: Bool) {
    shouldAutoFocus = autoFocus
  }

  func setAutoCorrect(_ autoCorrect: Bool) {
    textView.autocorrectionType = autoCorrect ? .yes : .no
  }

  func setSpellCheck(_ spellCheck: Bool) {
    textView.spellCheckingType = spellCheck ? .yes : .no
  }

  func setEnterBehavior(_ behavior: String) {
    textView.enterBehavior = ComposerEnterBehavior(rawValue: behavior) ?? .send
  }

  func setSubmitTitle(_ title: String) {
    textView.submitTitle = title
  }

  func setAlternateSubmitTitle(_ title: String) {
    textView.alternateSubmitTitle = title
  }

  func setTextPasteThresholdBytes(_ threshold: Int) {
    textView.textPasteThresholdBytes = threshold
  }

  func setMaxInputChars(_ maxInputChars: Int) {
    textView.maxInputChars = maxInputChars
  }

  func focusEditor() {
    textView.becomeFirstResponder()
  }

  func blurEditor() {
    textView.resignFirstResponder()
  }

  func setSelection(start: Int, end: Int) {
    requestedSelection = ComposerSelectionPayload(start: start, end: end)
    applyRequestedSelection()
  }

  public func textViewDidChange(_ textView: UITextView) {
    emitTextChange()
  }

  public func textViewDidChangeSelection(_ textView: UITextView) {
    guard !isApplyingControlledValue else {
      return
    }
    restoreBaseTypingAttributes()
    // UIKit moves the selection before textViewDidChange runs. Emitting here
    // would pair the post-edit text with a pre-edit revision counter, so let
    // the change event that follows carry both; only pure caret moves emit.
    guard self.textView.serializedText() == value else {
      return
    }
    emitSelection()
  }

  public func textView(
    _ textView: UITextView,
    shouldChangeTextIn range: NSRange,
    replacementText text: String
  ) -> Bool {
    restoreBaseTypingAttributes()
    return !isReadOnly
  }

  public func textDroppableView(
    _ textDroppableView: UIView & UITextDroppable,
    proposalForDrop drop: UITextDropRequest
  ) -> UITextDropProposal {
    guard !isReadOnly else {
      return UITextDropProposal(operation: .cancel)
    }
    guard droppedImageProviders(in: drop) != nil else {
      return drop.suggestedProposal
    }

    // The composer owns image drops so UIKit does not insert NSTextAttachments
    // that the controlled plain-text value cannot represent.
    let proposal = UITextDropProposal(operation: .copy)
    proposal.dropAction = .insert
    proposal.dropPerformer = .delegate
    return proposal
  }

  public func textDroppableView(
    _ textDroppableView: UIView & UITextDroppable,
    willPerformDrop drop: UITextDropRequest
  ) {
    guard !isReadOnly else {
      return
    }
    guard let imageProviders = droppedImageProviders(in: drop) else {
      return
    }
    textView.loadImages(from: imageProviders)
  }

  private func droppedImageProviders(in drop: UITextDropRequest) -> [NSItemProvider]? {
    let providers = drop.dropSession.items.map(\.itemProvider)
    guard !providers.isEmpty,
          providers.allSatisfy({ $0.canLoadObject(ofClass: UIImage.self) }) else {
      return nil
    }
    return providers
  }

  public func textViewDidBeginEditing(_ textView: UITextView) {
    onComposerFocus()
  }

  public func textViewDidEndEditing(_ textView: UITextView) {
    onComposerBlur()
  }

  private func applyControlledDocument(force: Bool = false) {
    // Rebuilding the attributed string tears down an active IME composition.
    // Skip while marked text exists; committing the composition sends a new
    // value from JS, and that update rebuilds, keeping any skipped force.
    if textView.markedTextRange != nil {
      hasDeferredForcedRebuild = hasDeferredForcedRebuild || force
      updatePlaceholderVisibility()
      return
    }
    let shouldForce = force || hasDeferredForcedRebuild
    let currentSource = textView.serializedText()
    guard shouldForce || currentSource != value || !documentMatchesExpectedTokens() else {
      updatePlaceholderVisibility()
      return
    }
    hasDeferredForcedRebuild = false

    let previousSelection = sourceSelection()
    isApplyingControlledValue = true
    textView.attributedText = makeAttributedDocument()
    let targetSelection = requestedSelection ?? previousSelection
    requestedSelection = nil
    textView.selectedRange = displayRange(for: targetSelection)
    restoreBaseTypingAttributes()
    isApplyingControlledValue = false
    updatePlaceholderVisibility()
    emitContentSizeIfNeeded()
  }

  private func makeAttributedDocument() -> NSAttributedString {
    let result = NSMutableAttributedString()
    let source = value as NSString
    var cursor = 0
    let validTokens = tokens.filter {
      $0.start >= cursor &&
        $0.end > $0.start &&
        $0.end <= source.length &&
        source.substring(with: NSRange(location: $0.start, length: $0.end - $0.start)) == $0.source
    }

    for token in validTokens {
      if token.start < cursor {
        continue
      }
      if token.start > cursor {
        appendPlainText(
          source.substring(with: NSRange(location: cursor, length: token.start - cursor)),
          to: result
        )
      }
      result.append(makeAttachmentString(token))
      cursor = token.end
    }
    if cursor < source.length {
      appendPlainText(
        source.substring(with: NSRange(location: cursor, length: source.length - cursor)),
        to: result
      )
    }
    return result
  }

  private func appendPlainText(_ text: String, to result: NSMutableAttributedString) {
    result.append(NSAttributedString(string: text, attributes: baseAttributes()))
  }

  private func makeAttachmentString(_ token: ComposerTokenPayload) -> NSAttributedString {
    let color = token.accent.flatMap { UIColor(composerHex: $0) }
      ?? UIColor(composerHex: theme.text) ?? .label
    let chipFont = UIFont(name: "DMSans-Medium", size: fontSize)
      ?? UIFont.systemFont(ofSize: fontSize, weight: .medium)
    let icon = token.iconUri.flatMap(iconImage(for:)).map {
      token.tintsIcon == true ? Self.tinted($0, color: color) : $0
    }
    let image = renderChip(
      label: token.label,
      detail: token.detail,
      icon: icon,
      color: color,
      font: chipFont
    )
    let attachment = ComposerTextAttachment(
      source: token.source,
      label: token.label,
      image: image,
      size: image.size,
      baselineOffset: chipFont.ascender - image.size.height
    )
    let attributedAttachment = NSMutableAttributedString(attachment: attachment)
    attributedAttachment.addAttributes(
      baseAttributes(),
      range: NSRange(location: 0, length: attributedAttachment.length)
    )
    return attributedAttachment
  }

  private func renderChip(
    label: String,
    detail: String?,
    icon: UIImage?,
    color: UIColor,
    font: UIFont
  ) -> UIImage {
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = .left
    paragraph.lineBreakMode = .byTruncatingMiddle
    let attributedLabel = NSMutableAttributedString(
      string: label,
      attributes: [.font: font, .foregroundColor: color, .paragraphStyle: paragraph]
    )
    // The size reads as metadata, not part of the name, so it renders a step down from the
    // label the way the web chip does.
    if let detail, !detail.isEmpty {
      let detailFont = font.withSize(font.pointSize * 0.84)
      attributedLabel.append(
        NSAttributedString(
          string: " \(detail)",
          attributes: [.font: detailFont, .foregroundColor: color, .paragraphStyle: paragraph]
        )
      )
    }
    let iconSide = font.pointSize
    let iconSlot: CGFloat = icon == nil ? 0 : iconSide * 1.25
    let padding: CGFloat = 5
    let height = ceil(font.ascender - font.descender)
    // A long path would otherwise draw a chip wider than the composer and clip. Cap the label
    // to the text the editor can actually show and truncate inside it, as Android's
    // `maximumWidth` does, so the chip always fits the line it sits on.
    let availableWidth = textView.textContainer.size.width > 0
      ? textView.textContainer.size.width - textView.textContainer.lineFragmentPadding * 2
      : (textView.window?.bounds.width ?? bounds.width)
    if availableWidth <= 0 {
      chipsNeedMeasuredWidth = true
    }
    let maximumLabelWidth = max(font.pointSize * 3, availableWidth - padding * 2 - iconSlot)
    let labelWidth = min(attributedLabel.size().width, maximumLabelWidth)
    let width = ceil(padding * 2 + iconSlot + labelWidth)
    let format = UIGraphicsImageRendererFormat.preferred()
    format.opaque = false
    let renderer = UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format)
    return renderer.image { _ in
      if let icon {
        icon.draw(
          in: CGRect(x: padding, y: (height - iconSide) / 2, width: iconSide, height: iconSide)
        )
      }
      // Exactly the measured width: a spare pixel here would let a capped label draw past
      // the cap instead of truncating inside it.
      attributedLabel.draw(
        in: CGRect(x: padding + iconSlot, y: 0, width: labelWidth, height: height)
      )
    }
  }

  private static func tinted(_ image: UIImage, color: UIColor) -> UIImage {
    let format = UIGraphicsImageRendererFormat.preferred()
    format.scale = image.scale
    format.opaque = false
    return UIGraphicsImageRenderer(size: image.size, format: format).image { _ in
      color.setFill()
      UIRectFill(CGRect(origin: .zero, size: image.size))
      image.draw(at: .zero, blendMode: .destinationIn, alpha: 1)
    }
  }

  private func iconImage(for uri: String) -> UIImage? {
    if let image = iconImages[uri] {
      return image
    }
    guard !pendingIconUris.contains(uri), let url = URL(string: uri) else {
      return nil
    }

    if url.isFileURL, let image = UIImage(contentsOfFile: url.path) {
      iconImages[uri] = image
      return image
    }

    pendingIconUris.insert(uri)
    URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
      guard let self, let data, let image = UIImage(data: data) else {
        DispatchQueue.main.async {
          self?.pendingIconUris.remove(uri)
        }
        return
      }
      DispatchQueue.main.async {
        self.pendingIconUris.remove(uri)
        self.iconImages[uri] = image
        self.applyControlledDocument(force: true)
      }
    }.resume()
    return nil
  }

  private func baseAttributes() -> [NSAttributedString.Key: Any] {
    let font = UIFont(name: fontFamily, size: fontSize)
      ?? UIFont.systemFont(ofSize: fontSize)
    let paragraph = NSMutableParagraphStyle()
    paragraph.minimumLineHeight = lineHeight
    paragraph.maximumLineHeight = lineHeight
    return [
      .font: font,
      .foregroundColor: UIColor(composerHex: theme.text) ?? .label,
      .paragraphStyle: paragraph,
    ]
  }

  private func applyTypography() {
    let font = UIFont(name: fontFamily, size: fontSize)
      ?? UIFont.systemFont(ofSize: fontSize)
    textView.font = font
    restoreBaseTypingAttributes()
    placeholderLabel.font = font
    setNeedsLayout()
  }

  private func restoreBaseTypingAttributes() {
    guard textView.markedTextRange == nil else {
      return
    }
    textView.typingAttributes = baseAttributes()
  }

  private func applyTheme() {
    textView.textColor = UIColor(composerHex: theme.text) ?? .label
    placeholderLabel.textColor = UIColor(composerHex: theme.placeholder) ?? .placeholderText
    tintColor = UIColor.systemBlue
  }

  private func emitTextChange() {
    guard !isApplyingControlledValue else {
      return
    }
    value = textView.serializedText()
    let selection = sourceSelection()
    nativeEventCount += 1
    onComposerChange([
      "value": value,
      "selection": ["start": selection.start, "end": selection.end],
      "eventCount": nativeEventCount,
    ])
    updatePlaceholderVisibility()
    emitContentSizeIfNeeded()
  }

  private func emitSelection() {
    // Caret moves advance the revision counter like text edits do: a
    // controlled payload computed before this move is stale and must fail the
    // revision guard instead of yanking the caret back mid-typing.
    let currentValue = textView.serializedText()
    let selection = sourceSelection()
    nativeEventCount += 1
    onComposerSelectionChange([
      "value": currentValue,
      "selection": ["start": selection.start, "end": selection.end],
      "eventCount": nativeEventCount,
    ])
  }

  private func sourceSelection() -> ComposerSelectionPayload {
    ComposerSelectionPayload(
      start: textView.sourceOffset(forDisplayOffset: textView.selectedRange.location),
      end: textView.sourceOffset(forDisplayOffset: NSMaxRange(textView.selectedRange))
    )
  }

  private func displayRange(for selection: ComposerSelectionPayload) -> NSRange {
    let start = displayOffset(forSourceOffset: selection.start)
    let end = displayOffset(forSourceOffset: selection.end)
    return NSRange(location: start, length: max(0, end - start))
  }

  private func displayOffset(forSourceOffset sourceOffset: Int) -> Int {
    let boundedOffset = max(0, min((value as NSString).length, sourceOffset))
    var collapsedLength = 0
    for token in tokens where token.end <= boundedOffset {
      collapsedLength += max(0, token.end - token.start - 1)
    }
    if let token = tokens.first(where: { $0.start < boundedOffset && boundedOffset < $0.end }) {
      return token.start - collapsedLength + 1
    }
    return boundedOffset - collapsedLength
  }

  private func applyRequestedSelection() {
    guard let requestedSelection else {
      return
    }
    let nextRange = displayRange(for: requestedSelection)
    guard nextRange.location <= textView.attributedText.length,
          NSMaxRange(nextRange) <= textView.attributedText.length else {
      return
    }
    self.requestedSelection = nil
    // Programmatically assigning selectedRange resets the keyboard's
    // autocorrect and predictive-text context even when the range is
    // unchanged, so a no-op assignment must be skipped.
    guard !NSEqualRanges(nextRange, textView.selectedRange) else {
      return
    }
    isApplyingControlledValue = true
    textView.selectedRange = nextRange
    isApplyingControlledValue = false
  }

  private func updatePlaceholderVisibility() {
    placeholderLabel.isHidden = !value.isEmpty
  }

  private func emitContentSizeIfNeeded() {
    // The laid-out text without insets. A one-line draft reports its natural width, so
    // JS can tell whether it fits a narrower row than the one it is laid out in; past
    // one line only the height matters, so layout stops at the second line. The width
    // comes from the line fragment because usedRect spans the container once the view
    // scrolls. A trailing newline's empty line only exists as the extra fragment.
    let layout = textView.layoutManager
    let container = textView.textContainer
    var lines = 0
    var width: CGFloat = 0
    var height: CGFloat = 0
    let glyphs = NSRange(location: 0, length: layout.numberOfGlyphs)
    layout.enumerateLineFragments(forGlyphRange: glyphs) { _, used, _, _, stop in
      lines += 1
      width = used.width
      height = used.maxY
      if lines > 1 { stop.pointee = true }
    }
    if lines < 2, layout.extraLineFragmentTextContainer === container {
      lines += 1
      height = max(height, layout.extraLineFragmentUsedRect.maxY)
    }
    let nextSize = CGSize(width: lines == 1 ? ceil(width) : 0, height: ceil(height))
    guard abs(nextSize.width - lastContentSize.width) > 0.5 ||
      abs(nextSize.height - lastContentSize.height) > 0.5 else {
      return
    }
    lastContentSize = nextSize
    onComposerContentSizeChange(["width": nextSize.width, "height": nextSize.height])
  }

  private func decode<T: Decodable>(_ type: T.Type, from json: String) -> T? {
    guard let data = json.data(using: .utf8) else {
      return nil
    }
    return try? JSONDecoder().decode(type, from: data)
  }

  private func tokensMatchCurrentValue() -> Bool {
    let source = value as NSString
    return tokens.allSatisfy {
      $0.start >= 0 &&
        $0.end > $0.start &&
        $0.end <= source.length &&
        source.substring(with: NSRange(location: $0.start, length: $0.end - $0.start)) == $0.source
    }
  }

  private func documentMatchesExpectedTokens() -> Bool {
    let source = value as NSString
    let expectedSources = tokens.compactMap { token -> String? in
      guard token.start >= 0,
            token.end > token.start,
            token.end <= source.length,
            source.substring(
              with: NSRange(location: token.start, length: token.end - token.start)
            ) == token.source else {
        return nil
      }
      return token.source
    }
    var renderedSources: [String] = []
    textView.attributedText.enumerateAttribute(
      .attachment,
      in: NSRange(location: 0, length: textView.attributedText.length)
    ) { value, _, _ in
      if let attachment = value as? ComposerTextAttachment {
        renderedSources.append(attachment.source)
      }
    }
    return renderedSources == expectedSources
  }
}

private extension UIColor {
  convenience init?(composerHex hex: String?) {
    guard var value = hex?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
      return nil
    }
    if value.hasPrefix("#") {
      value.removeFirst()
    }
    guard value.count == 6 || value.count == 8,
          let raw = UInt64(value, radix: 16) else {
      return nil
    }
    if value.count == 8 {
      self.init(
        red: CGFloat((raw >> 24) & 0xff) / 255,
        green: CGFloat((raw >> 16) & 0xff) / 255,
        blue: CGFloat((raw >> 8) & 0xff) / 255,
        alpha: CGFloat(raw & 0xff) / 255
      )
    } else {
      self.init(
        red: CGFloat((raw >> 16) & 0xff) / 255,
        green: CGFloat((raw >> 8) & 0xff) / 255,
        blue: CGFloat(raw & 0xff) / 255,
        alpha: 1
      )
    }
  }
}
