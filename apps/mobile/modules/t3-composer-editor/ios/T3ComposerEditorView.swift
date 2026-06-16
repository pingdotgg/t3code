import ExpoModulesCore
import UIKit

private struct ComposerTokenPayload: Decodable {
  let type: String
  let source: String
  let label: String
  let iconUri: String?
  let start: Int
  let end: Int
}

private struct ComposerSelectionPayload: Decodable {
  let start: Int
  let end: Int
}

private struct ComposerThemePayload: Decodable {
  let text: String
  let placeholder: String
  let chipBackground: String
  let chipBorder: String
  let chipText: String
  let skillBackground: String
  let skillBorder: String
  let skillText: String
  let fileTint: String
}

private struct ComposerChipStyle {
  let tint: UIColor
  let backgroundColor: UIColor
  let borderColor: UIColor
  let textColor: UIColor
}

private final class ComposerTextAttachment: NSTextAttachment {
  let source: String

  init(source: String, image: UIImage, size: CGSize, baselineOffset: CGFloat) {
    self.source = source
    super.init(data: nil, ofType: nil)
    self.image = image
    bounds = CGRect(x: 0, y: baselineOffset, width: size.width, height: size.height)
  }

  required init?(coder: NSCoder) {
    nil
  }
}

private final class ComposerTextView: UITextView {
  private static let pastedImageDirectoryName = "t3-composer-paste"
  private static let stalePastedImageAge: TimeInterval = 60 * 60

  var onPasteImages: (([String]) -> Void)?
  var onAttributedMutation: (() -> Void)?

  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
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
    let pasteboard = UIPasteboard.general
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
    super.paste(sender)
  }

  override func deleteBackward() {
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

  private func loadImages(from providers: [NSItemProvider]) {
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
      let urls = images.compactMap { $0 }.compactMap(Self.writeTemporaryImage)
      if !urls.isEmpty {
        self?.onPasteImages?(urls)
      }
    }
  }

  override func copy(_ sender: Any?) {
    guard selectedRange.length > 0 else {
      return super.copy(sender)
    }
    UIPasteboard.general.string = serializedText(in: selectedRange)
  }

  override func cut(_ sender: Any?) {
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

public final class T3ComposerEditorView: ExpoView, UITextViewDelegate {
  private let textView = ComposerTextView()
  private let placeholderLabel = UILabel()
  private var value = ""
  private var tokensJson = "[]"
  private var tokens: [ComposerTokenPayload] = []
  private var requestedSelection: ComposerSelectionPayload?
  private var theme = ComposerThemePayload(
    text: "#262626",
    placeholder: "#8e8e93",
    chipBackground: "#f2f2f7",
    chipBorder: "#dedee3",
    chipText: "#262626",
    skillBackground: "#f9e8fb",
    skillBorder: "#e5a6eb",
    skillText: "#a21caf",
    fileTint: "#737373"
  )
  private var fontFamily = "DMSans_400Regular"
  private var fontSize: CGFloat = 15
  private var lineHeight: CGFloat = 22
  private var contentInsetVertical: CGFloat = 0
  private var shouldAutoFocus = false
  private var didAutoFocus = false
  private var isApplyingControlledValue = false
  private var lastContentSize = CGSize.zero
  private var iconImages: [String: UIImage] = [:]
  private var pendingIconUris = Set<String>()
  private var tokensNeedRebuild = false

  let onComposerChange = EventDispatcher()
  let onComposerSelectionChange = EventDispatcher()
  let onComposerFocus = EventDispatcher()
  let onComposerBlur = EventDispatcher()
  let onComposerPasteImages = EventDispatcher()
  let onComposerContentSizeChange = EventDispatcher()

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)

    clipsToBounds = false
    textView.delegate = self
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
    textView.onAttributedMutation = { [weak self] in
      self?.emitTextChange()
    }
    addSubview(textView)

    placeholderLabel.numberOfLines = 0
    placeholderLabel.adjustsFontForContentSizeCategory = true
    addSubview(placeholderLabel)
    applyTypography()
    applyTheme()
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    textView.frame = bounds
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

  func setValue(_ value: String) {
    self.value = value
    applyControlledDocument(force: tokensNeedRebuild)
    if tokensMatchCurrentValue() {
      tokensNeedRebuild = false
    }
  }

  func setTokensJson(_ tokensJson: String) {
    guard self.tokensJson != tokensJson else {
      return
    }
    self.tokensJson = tokensJson
    tokens = decode([ComposerTokenPayload].self, from: tokensJson) ?? []
    tokensNeedRebuild = true
    applyControlledDocument(force: true)
    if tokensMatchCurrentValue() {
      tokensNeedRebuild = false
    }
  }

  func setSelectionJson(_ selectionJson: String) {
    requestedSelection = decode(ComposerSelectionPayload.self, from: selectionJson)
    applyRequestedSelection()
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
    emitSelection()
  }

  public func textViewDidBeginEditing(_ textView: UITextView) {
    onComposerFocus()
  }

  public func textViewDidEndEditing(_ textView: UITextView) {
    onComposerBlur()
  }

  private func applyControlledDocument(force: Bool = false) {
    let currentSource = textView.serializedText()
    guard force || currentSource != value || !documentMatchesExpectedTokens() else {
      updatePlaceholderVisibility()
      return
    }

    let previousSelection = sourceSelection()
    isApplyingControlledValue = true
    textView.attributedText = makeAttributedDocument()
    let targetSelection = requestedSelection ?? previousSelection
    requestedSelection = nil
    textView.selectedRange = displayRange(for: targetSelection)
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
    let isSkill = token.type == "skill"
    let tint = UIColor(composerHex: isSkill ? theme.skillText : theme.fileTint) ?? .secondaryLabel
    let iconName = isSkill ? "cube" : "doc"
    let iconImage = token.iconUri.flatMap(iconImage(for:))
    let style = ComposerChipStyle(
      tint: tint,
      backgroundColor: UIColor(
        composerHex: isSkill ? theme.skillBackground : theme.chipBackground
      ) ?? .secondarySystemFill,
      borderColor: UIColor(
        composerHex: isSkill ? theme.skillBorder : theme.chipBorder
      ) ?? .separator,
      textColor: UIColor(composerHex: isSkill ? theme.skillText : theme.chipText) ?? .label
    )
    let image = renderChip(
      label: token.label,
      iconName: iconName,
      iconImage: iconImage,
      style: style
    )
    let font = UIFont(name: fontFamily, size: fontSize)
      ?? UIFont.systemFont(ofSize: fontSize)
    let baselineOffset = floor((font.capHeight - image.size.height) / 2)
    let attachment = ComposerTextAttachment(
      source: token.source,
      image: image,
      size: image.size,
      baselineOffset: baselineOffset
    )
    return NSAttributedString(attachment: attachment)
  }

  private func renderChip(
    label: String,
    iconName: String,
    iconImage: UIImage?,
    style: ComposerChipStyle
  ) -> UIImage {
    let font = UIFont(name: "DMSans_500Medium", size: max(12, fontSize - 2))
      ?? UIFont.systemFont(ofSize: max(12, fontSize - 2), weight: .medium)
    let fallbackIcon = UIImage(
      systemName: iconName,
      withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .medium)
    )
    let icon = iconImage ?? fallbackIcon
    let textSize = (label as NSString).size(withAttributes: [.font: font])
    let iconWidth = icon == nil ? 0 : 14
    let iconGap = icon == nil ? 0 : 5
    let height: CGFloat = 24
    let width = ceil(9 + CGFloat(iconWidth + iconGap) + textSize.width + 9)
    let format = UIGraphicsImageRendererFormat.preferred()
    format.opaque = false
    let renderer = UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format)
    return renderer.image { context in
      let rect = CGRect(origin: .zero, size: CGSize(width: width, height: height))
      let path = UIBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), cornerRadius: 7)
      style.backgroundColor.setFill()
      path.fill()
      style.borderColor.setStroke()
      path.lineWidth = 1
      path.stroke()

      var x: CGFloat = 9
      if let icon {
        let renderedIcon = iconImage == nil
          ? icon.withTintColor(style.tint, renderingMode: .alwaysOriginal)
          : icon
        renderedIcon.draw(
          in: CGRect(x: x, y: 5, width: 14, height: 14)
        )
        x += 19
      }
      let paragraph = NSMutableParagraphStyle()
      paragraph.alignment = .left
      (label as NSString).draw(
        in: CGRect(x: x, y: 3, width: textSize.width + 1, height: 18),
        withAttributes: [
          .font: font,
          .foregroundColor: style.textColor,
          .paragraphStyle: paragraph,
        ]
      )
      context.cgContext.setAllowsAntialiasing(true)
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
    textView.typingAttributes = baseAttributes()
    placeholderLabel.font = font
    setNeedsLayout()
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
    onComposerChange([
      "value": value,
      "selection": ["start": selection.start, "end": selection.end],
    ])
    updatePlaceholderVisibility()
    emitContentSizeIfNeeded()
  }

  private func emitSelection() {
    let selection = sourceSelection()
    onComposerSelectionChange([
      "selection": ["start": selection.start, "end": selection.end],
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
    isApplyingControlledValue = true
    textView.selectedRange = nextRange
    isApplyingControlledValue = false
  }

  private func updatePlaceholderVisibility() {
    placeholderLabel.isHidden = !value.isEmpty
  }

  private func emitContentSizeIfNeeded() {
    let nextSize = textView.contentSize
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
