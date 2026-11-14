import ExpoModulesCore
import Foundation
import GhosttyKit
import QuartzCore
import UIKit

private enum GhosttyRuntime {
  private static let lock = NSLock()
  private static var initialized = false

  static func ensureInitialized() -> Bool {
    lock.lock()
    defer { lock.unlock() }

    if initialized {
      return true
    }

    let result = ghostty_init(0, nil)
    initialized = result == GHOSTTY_SUCCESS
    return initialized
  }
}

/// While a text field is first responder, iPadOS may consume presses before pressesBegan.
/// Priority UIKeyCommands capture terminal shortcuts before the text-input system handles them.
private enum TerminalHardwareKeyEncoder {
  private static let controlInputs = "abcdefghijklmnopqrstuvwxyz@[\\]^_-? "

  static func makeKeyCommands(action: Selector) -> [UIKeyCommand] {
    var commands: [UIKeyCommand] = []

    let specialInputs = [
      UIKeyCommand.inputEscape,
      UIKeyCommand.inputUpArrow,
      UIKeyCommand.inputDownArrow,
      UIKeyCommand.inputLeftArrow,
      UIKeyCommand.inputRightArrow,
      "\t",
    ]
    for input in specialInputs {
      commands.append(makeCommand(input: input, modifierFlags: [], action: action))
    }
    commands.append(makeCommand(input: "\t", modifierFlags: .shift, action: action))

    for character in controlInputs {
      commands.append(makeCommand(input: String(character), modifierFlags: .control, action: action))
      commands.append(
        makeCommand(input: String(character), modifierFlags: [.control, .shift], action: action)
      )
    }

    return commands
  }

  private static func makeCommand(
    input: String,
    modifierFlags: UIKeyModifierFlags,
    action: Selector
  ) -> UIKeyCommand {
    let command = UIKeyCommand(input: input, modifierFlags: modifierFlags, action: action)
    command.wantsPriorityOverSystemBehavior = true
    return command
  }

  static func sequence(input: String, modifiers: UIKeyModifierFlags) -> String? {
    switch input {
    case UIKeyCommand.inputEscape:
      return "\u{1B}"
    case UIKeyCommand.inputUpArrow:
      return "\u{1B}[A"
    case UIKeyCommand.inputDownArrow:
      return "\u{1B}[B"
    case UIKeyCommand.inputRightArrow:
      return "\u{1B}[C"
    case UIKeyCommand.inputLeftArrow:
      return "\u{1B}[D"
    case "\t":
      return modifiers.contains(.shift) ? "\u{1B}[Z" : "\t"
    default:
      break
    }

    guard modifiers.contains(.control) else { return nil }
    guard let scalar = input.lowercased().unicodeScalars.first else { return nil }
    return controlSequence(for: scalar)
  }

  private static func controlSequence(for scalar: Unicode.Scalar) -> String? {
    switch scalar {
    case "a"..."z":
      return UnicodeScalar(scalar.value - 96).map(String.init)
    case " ", "@":
      return "\u{00}"
    case "[":
      return "\u{1B}"
    case "\\":
      return "\u{1C}"
    case "]":
      return "\u{1D}"
    case "^":
      return "\u{1E}"
    case "_", "-":
      return "\u{1F}"
    case "?":
      return "\u{7F}"
    default:
      return nil
    }
  }
}

/// Ghostty callbacks can fire during deinit and hop to main after it, so they must not retain the view.
private final class TerminalViewRef {
  weak var view: T3TerminalView?
}

private enum TerminalInputSequence {
  /// Terminal Enter is carriage return. Sending line feed instead is Ctrl+J,
  /// which raw-mode TUIs may interpret as the literal J key.
  static let carriageReturn = "\r"

  static func normalizingReturn(_ input: String) -> String {
    switch input {
    case "\n", "\r\n":
      return carriageReturn
    default:
      return input
    }
  }
}

private final class TerminalInputField: UITextField {
  var onDeleteBackward: (() -> Void)?
  var onInsert: ((String) -> Void)?
  var onPaste: (() -> Void)?

  private static let hardwareKeyCommands = TerminalHardwareKeyEncoder.makeKeyCommands(
    action: #selector(handleHardwareKeyCommand(_:))
  )

  // While an IME composes, arrows, Tab and Escape pick or cancel candidates instead.
  override var keyCommands: [UIKeyCommand]? {
    markedTextRange == nil ? Self.hardwareKeyCommands : nil
  }

  override func deleteBackward() {
    // Backspace edits marked or committed field text first; the field diff sends that DEL.
    if markedTextRange == nil, !hasText {
      onDeleteBackward?()
    }
    super.deleteBackward()
  }

  // System pastes must bypass typed input to preserve paste encoding and chunking.
  override func paste(_ sender: Any?) {
    // Commit an in-progress composition first so it reaches the PTY ahead of the paste.
    if markedTextRange != nil {
      unmarkText()
      sendActions(for: .editingChanged)
    }
    onPaste?()
  }

  @objc
  private func handleHardwareKeyCommand(_ command: UIKeyCommand) {
    guard let input = command.input else { return }
    guard let sequence = TerminalHardwareKeyEncoder.sequence(
      input: input,
      modifiers: command.modifierFlags
    ) else { return }
    onInsert?(sequence)
  }
}

private enum TerminalAppearanceScheme: String {
  case light
  case dark

  init(value: String) {
    self = TerminalAppearanceScheme(rawValue: value) ?? .dark
  }

  var ghosttyColorScheme: ghostty_color_scheme_e {
    switch self {
    case .light:
      return GHOSTTY_COLOR_SCHEME_LIGHT
    case .dark:
      return GHOSTTY_COLOR_SCHEME_DARK
    }
  }
}

private extension UIColor {
  convenience init(hexString: String) {
    let sanitized = hexString.replacingOccurrences(of: "#", with: "")
    let value = Int(sanitized, radix: 16) ?? 0
    self.init(
      red: CGFloat((value >> 16) & 0xFF) / 255,
      green: CGFloat((value >> 8) & 0xFF) / 255,
      blue: CGFloat(value & 0xFF) / 255,
      alpha: 1
    )
  }
}

public final class T3TerminalView: ExpoView, UITextFieldDelegate, UIEditMenuInteractionDelegate {
  private static let minimumVerticalScrollStepPoints: CGFloat = 18
  private static let verticalScrollStepMultiplier: CGFloat = 1.15

  private let terminalViewport = UIView()
  private let inputField = TerminalInputField()
  private let focusTapGesture = UITapGestureRecognizer()
  private let scrollPanGesture = UIPanGestureRecognizer()
  private let editMenuGesture = UILongPressGestureRecognizer()
  private lazy var editMenuInteraction = UIEditMenuInteraction(delegate: self)
  private var lastViewportSize: CGSize = .zero
  private var lastContentScale: CGFloat = 0
  private var lastReportedGrid: (cols: Int, rows: Int)?
  private var lastAppliedBuffer = ""
  private var streamedOutput: TerminalOutputBuffer?
  private var pendingVerticalScrollPoints: CGFloat = 0
  private var menuText: String?
  private var sentInput = ""
  private var app: ghostty_app_t?
  private let callbackRef = TerminalViewRef()
  private var surface: ghostty_surface_t?
  private var isCreatingSurface = false
  private var surfaceCreationFailed = false
  private var appearance = TerminalAppearanceScheme.dark
  private var backgroundColorValue = UIColor(hexString: "#24292e")

  let onInput = EventDispatcher()
  let onResize = EventDispatcher()
  let onCapture = EventDispatcher()
  let onPaste = EventDispatcher()
  var captureRequest: Double = 0 {
    didSet {
      guard captureRequest > 0, captureRequest != oldValue else { return }
      let text = readViewportText() ?? ""
      // Android joins snapshot rows with "\n" and trims each row's trailing whitespace, so do
      // the same here: identical terminal content must capture identically on both platforms.
      let normalized = text.split(separator: "\n", omittingEmptySubsequences: false)
        .map { row -> String in
          var line = String(row)
          // Kotlin's trimEnd only strips ASCII whitespace; match it exactly.
          while let last = line.last, last.isASCII && last.isWhitespace { line.removeLast() }
          return line
        }
        .joined(separator: "\n")
      onCapture(["text": normalized])
    }
  }

  var terminalKey: String = "" {
    didSet {
      accessibilityIdentifier = "t3-terminal-\(terminalKey)"
      if oldValue != terminalKey {
        resetSurface()
      }
    }
  }

  // Expo sets a batch's props in no fixed order, so the buffer waits for the whole batch:
  // output fed before the same batch's sharedGrid lands would be drawn, and clipped, at the
  // previous grid.
  var initialBuffer: String = "" {
    didSet {
      hasPendingBuffer = true
    }
  }
  private var hasPendingBuffer = false

  // The PTY grid shared by every attached client, or empty before the server reports one.
  // The surface draws this grid so its wrapping and cursor match the PTY; the view's own
  // fit still goes out through onResize.
  var sharedGrid: [Int] = [] {
    didSet {
      guard oldValue != sharedGrid else { return }
      resizeSurface()
    }
  }

  var fontSize: CGFloat = 10 {
    didSet {
      guard oldValue != fontSize else { return }
      inputField.font = UIFont.monospacedSystemFont(ofSize: max(fontSize, 13), weight: .regular)
      applyConfigInPlace()
    }
  }

  var focusRequest: Double = 0 {
    didSet {
      guard oldValue != focusRequest else { return }
      DispatchQueue.main.async { [weak self] in
        self?.requestKeyboardFocus()
      }
    }
  }

  var readOnly = false {
    didSet {
      if readOnly {
        inputField.resignFirstResponder()
      }
    }
  }

  var autoFocus = true {
    didSet {
      guard oldValue != autoFocus else { return }
      if autoFocus {
        requestKeyboardFocus()
      } else {
        inputField.resignFirstResponder()
      }
    }
  }

  var appearanceScheme: String = TerminalAppearanceScheme.dark.rawValue {
    didSet {
      guard oldValue != appearanceScheme else { return }
      appearance = TerminalAppearanceScheme(value: appearanceScheme)
      applyConfigInPlace()
    }
  }

  var themeConfig: String = "" {
    didSet {
      guard oldValue != themeConfig else { return }
      applyConfigInPlace()
    }
  }

  var backgroundColorHex: String = "#24292e" {
    didSet {
      backgroundColorValue = UIColor(hexString: backgroundColorHex)
      applyTheme()
    }
  }

  var foregroundColorHex: String = "#d1d5da"
  var mutedForegroundColorHex: String = "#959da5"

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    callbackRef.view = self

    applyTheme()
    clipsToBounds = true
    // The real scale arrives with the window; layoutSubviews corrects it.
    contentScaleFactor = traitCollection.displayScale

    terminalViewport.clipsToBounds = true
    terminalViewport.contentScaleFactor = contentScaleFactor
    terminalViewport.translatesAutoresizingMaskIntoConstraints = false
    terminalViewport.isUserInteractionEnabled = true

    inputField.delegate = self
    inputField.backgroundColor = UIColor.clear
    inputField.textColor = UIColor.clear
    inputField.tintColor = UIColor.clear
    inputField.font = UIFont.monospacedSystemFont(ofSize: max(fontSize, 13), weight: .regular)
    inputField.placeholder = ""
    inputField.autocorrectionType = .no
    inputField.autocapitalizationType = .none
    inputField.spellCheckingType = .no
    inputField.smartDashesType = .no
    inputField.smartQuotesType = .no
    inputField.smartInsertDeleteType = .no
    inputField.returnKeyType = .send
    inputField.keyboardType = .default
    inputField.enablesReturnKeyAutomatically = false
    inputField.translatesAutoresizingMaskIntoConstraints = false
    inputField.alpha = 0.02
    inputField.isAccessibilityElement = false
    inputField.accessibilityElementsHidden = true
    inputField.addTarget(self, action: #selector(handleInputEditingDidBegin), for: .editingDidBegin)
    inputField.addTarget(self, action: #selector(handleInputEditingChanged), for: .editingChanged)
    inputField.onDeleteBackward = { [weak self] in
      self?.emitInput("\u{7F}")
    }
    inputField.onInsert = { [weak self] data in
      self?.emitInput(data)
      self?.resetInputField()
    }
    inputField.onPaste = { [weak self] in
      self?.emitPaste()
    }

    focusTapGesture.addTarget(self, action: #selector(handleViewportTap))
    terminalViewport.addGestureRecognizer(focusTapGesture)
    scrollPanGesture.addTarget(self, action: #selector(handleViewportPan(_:)))
    scrollPanGesture.maximumNumberOfTouches = 1
    scrollPanGesture.cancelsTouchesInView = false
    terminalViewport.addGestureRecognizer(scrollPanGesture)
    editMenuGesture.addTarget(self, action: #selector(handleViewportLongPress(_:)))
    terminalViewport.addGestureRecognizer(editMenuGesture)
    terminalViewport.addInteraction(editMenuInteraction)
    focusTapGesture.require(toFail: editMenuGesture)

    addSubview(terminalViewport)
    addSubview(inputField)

    NSLayoutConstraint.activate([
      terminalViewport.leadingAnchor.constraint(equalTo: leadingAnchor),
      terminalViewport.trailingAnchor.constraint(equalTo: trailingAnchor),
      terminalViewport.topAnchor.constraint(equalTo: topAnchor),
      terminalViewport.bottomAnchor.constraint(equalTo: bottomAnchor),

      inputField.trailingAnchor.constraint(equalTo: trailingAnchor),
      inputField.topAnchor.constraint(equalTo: bottomAnchor, constant: 8),
      inputField.widthAnchor.constraint(equalToConstant: 1),
      inputField.heightAnchor.constraint(equalToConstant: 1),
    ])
  }

  deinit {
    destroySurface()
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    updateContentScale()

    let viewportSize = terminalViewport.bounds.size
    if surface == nil {
      createSurfaceIfPossible()
    }

    guard viewportSize != lastViewportSize || contentScaleFactor != lastContentScale else {
      return
    }

    lastViewportSize = viewportSize
    lastContentScale = contentScaleFactor
    resizeSurface()
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()

    guard window != nil, autoFocus else { return }
    DispatchQueue.main.async { [weak self] in
      self?.requestKeyboardFocus()
    }
  }

  public func textFieldShouldReturn(_ textField: UITextField) -> Bool {
    // Return during a composition commits it; that is not Enter.
    guard textField.markedTextRange == nil else { return false }
    emitInput(TerminalInputSequence.carriageReturn)
    resetInputField()
    return false
  }

  @objc
  private func handleViewportTap() {
    requestKeyboardFocus()
  }

  private func readViewportText() -> String? {
    guard let surface else { return nil }
    let selection = ghostty_selection_s(
      top_left: ghostty_point_s(tag: GHOSTTY_POINT_VIEWPORT, coord: GHOSTTY_POINT_COORD_TOP_LEFT, x: 0, y: 0),
      bottom_right: ghostty_point_s(tag: GHOSTTY_POINT_VIEWPORT, coord: GHOSTTY_POINT_COORD_BOTTOM_RIGHT, x: 0, y: 0),
      rectangle: false)
    var captured = ghostty_text_s()
    guard ghostty_surface_read_text(surface, selection, &captured) else { return nil }
    defer { ghostty_surface_free_text(surface, &captured) }
    guard let text = captured.text else { return nil }
    return String(
      bytes: UnsafeBufferPointer(
        start: UnsafeRawPointer(text).assumingMemoryBound(to: UInt8.self),
        count: Int(captured.text_len)),
      encoding: .utf8)
  }

  @objc
  private func handleViewportPan(_ gesture: UIPanGestureRecognizer) {
    guard let surface else { return }

    let location = gesture.location(in: terminalViewport)
    ghostty_surface_mouse_pos(
      surface,
      Double(location.x * contentScaleFactor),
      Double(location.y * contentScaleFactor),
      GHOSTTY_MODS_NONE
    )

    switch gesture.state {
    case .began:
      pendingVerticalScrollPoints = 0
      gesture.setTranslation(.zero, in: terminalViewport)
    case .changed:
      let translation = gesture.translation(in: terminalViewport)
      let stepSize = max(
        fontSize * Self.verticalScrollStepMultiplier,
        Self.minimumVerticalScrollStepPoints
      )
      let totalVerticalPoints = pendingVerticalScrollPoints + translation.y
      let verticalSteps = Int(totalVerticalPoints / stepSize)
      pendingVerticalScrollPoints = totalVerticalPoints - (CGFloat(verticalSteps) * stepSize)

      guard verticalSteps != 0 else {
        gesture.setTranslation(.zero, in: terminalViewport)
        return
      }

      ghostty_surface_mouse_scroll(surface, 0, Double(verticalSteps), 0)
      redrawSurface()
      gesture.setTranslation(.zero, in: terminalViewport)
    default:
      pendingVerticalScrollPoints = 0
      gesture.setTranslation(.zero, in: terminalViewport)
    }
  }

  // Korean keyboards build a syllable by replacing the committed character before the cursor,
  // so the field keeps what was sent and each change goes out as DELs plus the new suffix.
  // Scalars, not Characters: a Thai or Indic mark joins the previous grapheme, and resending
  // that grapheme after one DEL would leave its base twice in a code-point line editor.
  @objc
  private func handleInputEditingChanged() {
    guard inputField.markedTextRange == nil else { return }
    let text = inputField.text ?? ""
    let fieldScalars = text.unicodeScalars
    let sentScalars = sentInput.unicodeScalars
    let commonCount = zip(fieldScalars, sentScalars).prefix { $0.0 == $0.1 }.count
    let unsent = String(String.UnicodeScalarView(sentScalars.dropFirst(commonCount)))
    let added = String(String.UnicodeScalarView(fieldScalars.dropFirst(commonCount)))
    // Some software keyboards deliver Return as an inserted newline instead of textFieldShouldReturn.
    emitInput(String(repeating: "\u{7F}", count: unsent.count) + TerminalInputSequence.normalizingReturn(added))
    sentInput = text
    // A Hangul syllable never spans whitespace; past the cap, keep the last character to compose onto.
    if text.last?.isWhitespace == true {
      resetInputField()
    } else if text.count > 64 {
      let last = String(text.suffix(1))
      inputField.text = last
      sentInput = last
    }
  }

  @objc
  private func handleViewportLongPress(_ gesture: UILongPressGestureRecognizer) {
    guard gesture.state == .began else { return }
    // Freeze the text the user pressed on; output keeps streaming while the menu is open.
    menuText = readViewportText().flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
    guard menuText != nil || canPaste else { return }
    editMenuInteraction.presentEditMenu(
      with: UIEditMenuConfiguration(identifier: nil, sourcePoint: gesture.location(in: terminalViewport))
    )
  }

  public func editMenuInteraction(
    _ interaction: UIEditMenuInteraction,
    menuFor configuration: UIEditMenuConfiguration,
    suggestedActions: [UIMenuElement]
  ) -> UIMenu? {
    // The hidden input field would otherwise add actions such as Scan Text or Writing Tools.
    // Keep the system Paste command: unlike a custom action, it reads without a paste prompt.
    var children: [UIMenuElement] = Self.pasteCommand(in: suggestedActions).map { [$0] } ?? []
    if let text = menuText {
      children.append(
        UIAction(title: "Select Text", image: UIImage(systemName: "text.cursor")) { [weak self] _ in
          self?.presentTextSelection(text)
        })
    }
    return children.isEmpty ? nil : UIMenu(children: children)
  }

  private func presentTextSelection(_ text: String) {
    guard let window else { return }
    var responder: UIResponder? = self
    while let current = responder, !(current is UIViewController) {
      responder = current.next
    }
    guard let presenter = responder as? UIViewController,
      presenter.viewIfLoaded?.window === window,
      presenter.presentedViewController == nil,
      !presenter.isBeingPresented,
      !presenter.isBeingDismissed,
      presenter.transitionCoordinator == nil
    else { return }

    inputField.resignFirstResponder()
    let controller = TerminalTextSelectionViewController(text: text, fontSize: fontSize)
    let navigation = UINavigationController(rootViewController: controller)
    navigation.modalPresentationStyle = .pageSheet
    presenter.present(navigation, animated: !UIAccessibility.isReduceMotionEnabled)
  }

  private static func pasteCommand(in elements: [UIMenuElement]) -> UIMenuElement? {
    for element in elements {
      if let command = element as? UICommand,
         command.action == #selector(UIResponderStandardEditActions.paste(_:)) {
        return command
      }
      if let menu = element as? UIMenu, let command = pasteCommand(in: menu.children) {
        return command
      }
    }
    return nil
  }

  public override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if action == #selector(UIResponderStandardEditActions.paste(_:)) {
      return canPaste
    }
    return super.canPerformAction(action, withSender: sender)
  }

  public override func paste(_ sender: Any?) {
    emitPaste()
  }

  private var canPaste: Bool {
    !readOnly && UIPasteboard.general.hasStrings
  }

  @objc
  private func handleInputEditingDidBegin() {
    // A composition abandoned by losing focus must not reach the PTY with the next keystroke.
    resetInputField()
    textInputModeDidChange()
  }

  func resetInputField() {
    inputField.text = ""
    sentInput = ""
  }

  private func createSurfaceIfPossible() {
    guard surface == nil, app == nil, !isCreatingSurface, !surfaceCreationFailed else { return }
    guard terminalViewport.bounds.width > 0, terminalViewport.bounds.height > 0 else { return }
    guard GhosttyRuntime.ensureInitialized() else {
      surfaceCreationFailed = true
      return
    }

    isCreatingSurface = true
    defer { isCreatingSurface = false }

    var runtimeConfig = ghostty_runtime_config_s(
      userdata: Unmanaged.passUnretained(callbackRef).toOpaque(),
      supports_selection_clipboard: false,
      // The io thread queues app messages (titles, bells) in a bounded mailbox. Unless the main
      // thread drains it, the io thread blocks and the next feed or surface free hangs the app.
      wakeup_cb: { userdata in
        guard let userdata else { return }
        let ref = Unmanaged<TerminalViewRef>.fromOpaque(userdata).takeUnretainedValue()
        DispatchQueue.main.async { ref.view?.tickApp() }
      },
      action_cb: { _, _, _ in false },
      read_clipboard_cb: { _, _, _, _, _, _ in GHOSTTY_CLIPBOARD_READ_UNSUPPORTED },
      confirm_read_clipboard_cb: { _, _, _, _ in },
      write_clipboard_cb: { _, _, _, _, _ in },
      close_surface_cb: { _, _ in }
    )

    guard let config = ghostty_config_new() else {
      surfaceCreationFailed = true
      return
    }
    // Creation proceeds without the file, as before; font_size is also set on the surface config.
    _ = loadThemeConfig(into: config)
    ghostty_config_finalize(config)
    defer { ghostty_config_free(config) }

    guard let createdApp = ghostty_app_new(&runtimeConfig, config) else {
      surfaceCreationFailed = true
      return
    }

    var surfaceConfig = ghostty_surface_config_new()
    surfaceConfig.platform_tag = GHOSTTY_PLATFORM_IOS
    surfaceConfig.platform.ios.uiview = Unmanaged.passUnretained(terminalViewport).toOpaque()
    surfaceConfig.userdata = Unmanaged.passUnretained(self).toOpaque()
    surfaceConfig.scale_factor = Double(contentScaleFactor)
    surfaceConfig.font_size = Float(fontSize)
    surfaceConfig.context = GHOSTTY_SURFACE_CONTEXT_WINDOW
    surfaceConfig.use_custom_io = true

    guard let createdSurface = ghostty_surface_new(createdApp, &surfaceConfig) else {
      ghostty_app_free(createdApp)
      surfaceCreationFailed = true
      return
    }

    app = createdApp
    surface = createdSurface
    ghostty_app_set_color_scheme(createdApp, appearance.ghosttyColorScheme)
    ghostty_surface_set_color_scheme(createdSurface, appearance.ghosttyColorScheme)
    setupWriteCallback()
    resizeSurface()
    if let streamedOutput {
      feedData(streamedOutput.data)
    } else if !hasPendingBuffer {
      feedBuffer(initialBuffer)
    }
  }

  private func resetSurface() {
    destroySurface()
    lastAppliedBuffer = ""
    lastViewportSize = .zero
    lastContentScale = 0
    lastReportedGrid = nil
    surfaceCreationFailed = false
    setNeedsLayout()
  }

  // Font and theme change in place: a new surface would replay output and re-answer its queries.
  private func applyConfigInPlace() {
    guard let app, let surface else {
      resetSurface()
      return
    }
    guard let config = ghostty_config_new() else { return }
    defer { ghostty_config_free(config) }
    let loaded = loadThemeConfig(into: config)
    ghostty_config_finalize(config)
    ghostty_app_set_color_scheme(app, appearance.ghosttyColorScheme)
    ghostty_surface_set_color_scheme(surface, appearance.ghosttyColorScheme)
    tickApp()
    // Without the file, the config lacks font-size and would reset the surface to defaults.
    if loaded {
      ghostty_surface_update_config(surface, config)
    }
    resizeSurface()
    setNeedsLayout()
  }

  private func destroySurface() {
    // Unblock the io thread before ghostty_surface_free joins it.
    tickApp()
    if let surface {
      ghostty_surface_set_write_callback(surface, nil, nil)
      ghostty_surface_free(surface)
    }
    if let app {
      ghostty_app_free(app)
    }
    surface = nil
    app = nil
    // Ghostty adds its IOSurface layer to the viewport on iOS but never removes it on
    // free, leaving the last frame on screen under the next surface's layer. The
    // viewport has no subviews, so every sublayer belongs to a freed surface.
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    terminalViewport.layer.sublayers?.forEach { $0.removeFromSuperlayer() }
    CATransaction.commit()
  }

  func applyPendingBuffer() {
    guard hasPendingBuffer else { return }
    hasPendingBuffer = false
    applyRemoteBuffer(initialBuffer)
  }

  private func tickApp() {
    guard let app else { return }
    ghostty_app_tick(app)
  }

  private func applyRemoteBuffer(_ buffer: String) {
    guard streamedOutput == nil else { return }
    guard surface != nil else {
      createSurfaceIfPossible()
      return
    }

    if buffer.isEmpty {
      feedData(Data("\u{1B}[3J\u{1B}[H\u{1B}[2J".utf8))
      lastAppliedBuffer = ""
      return
    }

    if buffer.hasPrefix(lastAppliedBuffer) {
      let suffix = String(buffer.dropFirst(lastAppliedBuffer.count))
      feedData(Data(suffix.utf8))
      lastAppliedBuffer = buffer
      return
    }

    resetSurface()
    createSurfaceIfPossible()
  }

  func writeOutput(_ data: String, reset: Bool) {
    let output = streamedOutput ?? TerminalOutputBuffer()
    let bytes = Data(data.utf8)
    output.write(bytes, reset: reset)
    streamedOutput = output
    if reset {
      resetSurface()
    } else if surface == nil {
      createSurfaceIfPossible()
    } else {
      feedData(bytes)
    }
  }

  private func feedBuffer(_ buffer: String) {
    guard !buffer.isEmpty else { return }
    feedData(Data(buffer.utf8))
    lastAppliedBuffer = buffer
  }

  private func feedData(_ data: Data) {
    guard let surface, !data.isEmpty else { return }

    tickApp()
    data.withUnsafeBytes { buffer in
      guard let pointer = buffer.baseAddress?.assumingMemoryBound(to: UInt8.self) else {
        return
      }
      ghostty_surface_feed_data(surface, pointer, buffer.count)
    }

    redrawSurface()
  }

  private func setupWriteCallback() {
    guard let surface else { return }

    let userdata = Unmanaged.passUnretained(callbackRef).toOpaque()
    ghostty_surface_set_write_callback(surface, { userdata, data, len in
      guard let userdata, let data, len > 0 else { return }
      let ref = Unmanaged<TerminalViewRef>.fromOpaque(userdata).takeUnretainedValue()
      let bytes = Data(bytes: data, count: len)
      guard let input = String(data: bytes, encoding: .utf8), !input.isEmpty else { return }

      DispatchQueue.main.async {
        ref.view?.emitInput(input)
      }
    }, userdata)
  }

  private func resizeSurface() {
    guard let surface else {
      emitEstimatedResize()
      return
    }

    let scale = contentScaleFactor
    let width = UInt32(max(floor(terminalViewport.bounds.width * scale), 1))
    let height = UInt32(max(floor(terminalViewport.bounds.height * scale), 1))

    terminalViewport.contentScaleFactor = scale
    ghostty_surface_set_content_scale(surface, Double(scale), Double(scale))
    ghostty_surface_set_size(surface, width, height)
    let fitted = ghostty_surface_size(surface)
    let fittedCols = max(1, Int(fitted.columns))
    let fittedRows = max(1, Int(fitted.rows))
    // Trimming whole cells keeps ghostty's padding, and the surface can only shrink
    // within the view, so a stale larger grid falls back to the fitted one.
    var surfaceWidth = width
    var surfaceHeight = height
    if sharedGrid.count == 2, sharedGrid[0] > 0, sharedGrid[1] > 0 {
      surfaceWidth -= UInt32(max(fittedCols - sharedGrid[0], 0)) * fitted.cell_width_px
      surfaceHeight -= UInt32(max(fittedRows - sharedGrid[1], 0)) * fitted.cell_height_px
      if surfaceWidth != width || surfaceHeight != height {
        ghostty_surface_set_size(surface, surfaceWidth, surfaceHeight)
      }
    }
    ghostty_surface_set_occlusion(surface, window != nil)
    configureIOSurfaceLayers(
      size: CGSize(width: CGFloat(surfaceWidth) / scale, height: CGFloat(surfaceHeight) / scale))
    redrawSurface()
    emitResize(cols: fittedCols, rows: fittedRows)
  }

  private func redrawSurface() {
    guard let surface else { return }
    ghostty_surface_refresh(surface)
    ghostty_surface_draw(surface)
    markIOSurfaceLayersForDisplay()
  }

  private func emitEstimatedResize() {
    guard bounds.width > 0, bounds.height > 0 else { return }

    let cellWidth = max(fontSize * 0.62, 1)
    let cellHeight = max(fontSize * 1.35, 1)
    let cols = max(20, min(400, Int(bounds.width / cellWidth)))
    let terminalHeight = max(bounds.height, 0)
    let rows = max(5, min(200, Int(terminalHeight / cellHeight)))
    emitResize(cols: cols, rows: rows)
  }

  private func emitResize(cols: Int, rows: Int) {
    guard lastReportedGrid?.cols != cols || lastReportedGrid?.rows != rows else {
      return
    }

    lastReportedGrid = (cols, rows)
    onResize([
      "cols": cols,
      "rows": rows,
    ])
  }

  private func updateContentScale() {
    // The trait collection follows the scene the view is in, which matters once
    // iPhone apps run resizable and on external displays; UIScreen.main does not.
    let scale = traitCollection.displayScale
    if contentScaleFactor != scale {
      contentScaleFactor = scale
    }
  }

  private func requestKeyboardFocus() {
    guard window != nil, !readOnly else { return }
    inputField.becomeFirstResponder()
    textInputModeDidChange()
  }

  private func emitInput(_ data: String) {
    guard !readOnly, !data.isEmpty else { return }
    onInput(["data": data])
  }

  private func emitPaste() {
    guard let text = UIPasteboard.general.string, !text.isEmpty else { return }
    onPaste(["text": text])
  }

  private func textInputModeDidChange() {
    guard let app else { return }
    ghostty_app_keyboard_changed(app)
  }

  private func configureIOSurfaceLayers(size: CGSize) {
    let targetBounds = CGRect(origin: .zero, size: size)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    terminalViewport.layer.sublayers?.forEach { sublayer in
      sublayer.frame = targetBounds
      sublayer.contentsScale = contentScaleFactor
    }
    CATransaction.commit()
  }

  private func markIOSurfaceLayersForDisplay() {
    terminalViewport.layer.setNeedsDisplay()
    terminalViewport.layer.sublayers?.forEach { layer in
      layer.setNeedsDisplay()
    }
  }

  private func applyTheme() {
    backgroundColor = backgroundColorValue
    terminalViewport.backgroundColor = backgroundColorValue
  }

  private func loadThemeConfig(into config: ghostty_config_t) -> Bool {
    guard let path = writeThemeConfigFile() else { return false }
    path.withCString { cString in
      ghostty_config_load_file(config, cString)
    }
    return true
  }

  private func writeThemeConfigFile() -> String? {
    let configContents = "\(themeConfig)\nfont-size = \(String(format: "%g", Double(fontSize)))\n"
    let url = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("t3-terminal-theme-\(appearance.rawValue).ghostty")

    do {
      if let existing = try? String(contentsOf: url, encoding: .utf8), existing == configContents {
        return url.path
      }

      try configContents.write(to: url, atomically: true, encoding: .utf8)
      return url.path
    } catch {
      return nil
    }
  }
}
