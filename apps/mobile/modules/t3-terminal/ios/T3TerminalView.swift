import ExpoModulesCore
import Foundation
import GhosttyKit
import QuartzCore
import UIKit

/// One incremental terminal write from JS: `seq` orders and deduplicates the
/// writes, `reset` clears the grid before `data` is fed.
///
/// JS 侧的一次增量终端写入：`seq` 负责排序与去重，`reset` 表示喂入 `data`
/// 之前要先清屏。
public struct TerminalBufferWriteRecord: Record {
  public init() {}

  @Field public var seq: Int = 0
  @Field public var reset: Bool = false
  @Field public var data: String = ""
}

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

/// Encodes hardware-keyboard combos that UITextField never surfaces through its
/// text-editing delegate (control combos, Escape, Tab, arrow keys) into the byte
/// sequences a terminal expects.
///
/// Capture uses UIKeyCommand with `wantsPriorityOverSystemBehavior` rather than
/// `pressesBegan`: while a text field is first responder, iPadOS routes hardware key
/// events through the text-input system, which can consume presses before they reach
/// responder press callbacks. Registered key commands are matched deterministically
/// before that happens.
private enum TerminalHardwareKeyEncoder {
  /// Characters that produce a control byte when combined with Ctrl.
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
      // Ctrl+A..Z -> 0x01..0x1A (Ctrl+C = ETX, Ctrl+Z = SUB, ...).
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

  private static let hardwareKeyCommands = TerminalHardwareKeyEncoder.makeKeyCommands(
    action: #selector(handleHardwareKeyCommand(_:))
  )

  override var keyCommands: [UIKeyCommand]? {
    Self.hardwareKeyCommands
  }

  override func deleteBackward() {
    onDeleteBackward?()
    super.deleteBackward()
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

public final class T3TerminalView: ExpoView, UITextFieldDelegate {
  private static let minimumVerticalScrollStepPoints: CGFloat = 18
  private static let verticalScrollStepMultiplier: CGFloat = 1.15
  /// Matches `DEFAULT_MAX_TERMINAL_BUFFER_BYTES` on the client runtime, so a
  /// replay never holds more history than JS would have sent.
  ///
  /// 与 client runtime 的 `DEFAULT_MAX_TERMINAL_BUFFER_BYTES` 一致，
  /// 重放持有的历史不会超过 JS 会发送的量。
  private static let maxReplayBufferBytes = 512 * 1024
  /// Trim only once the buffer runs this far past the cap, so a rolling window
  /// costs one copy per slack window instead of one per write.
  ///
  /// 只有超出上限这么多才裁剪，滚动窗口的代价变成每个余量窗口一次拷贝，
  /// 而不是每次写入一次。
  private static let replayBufferTrimSlackBytes = 64 * 1024
  /// Erase scrollback, home the cursor, erase the screen.
  ///
  /// 清除滚动历史、光标归位、清屏。
  private static let clearScreenSequence = "\u{1B}[3J\u{1B}[H\u{1B}[2J"

  private let terminalViewport = UIView()
  private let inputField = TerminalInputField()
  private let focusTapGesture = UITapGestureRecognizer()
  private let scrollPanGesture = UIPanGestureRecognizer()
  private var lastViewportSize: CGSize = .zero
  private var lastContentScale: CGFloat = 0
  private var lastReportedGrid: (cols: Int, rows: Int)?
  /// Everything fed to the current terminal, replayed whenever the surface is
  /// rebuilt (font size change, key change, first layout). Bounded to the same
  /// retention window the JS side keeps.
  ///
  /// 当前终端已喂入的全部内容，surface 重建时（字号变化、key 变化、首次布局）
  /// 用它重放。上限与 JS 侧的保留窗口一致。
  private var replayBuffer = ""
  private var replayBufferBytes = 0
  private var appliedWriteSeq = 0
  private var pendingVerticalScrollPoints: CGFloat = 0
  private var app: ghostty_app_t?
  private var surface: ghostty_surface_t?
  private var isCreatingSurface = false
  private var isReplayingBuffer = false
  private var surfaceCreationFailed = false
  private var appearance = TerminalAppearanceScheme.dark
  private var backgroundColorValue = UIColor(hexString: "#24292e")

  let onInput = EventDispatcher()
  let onResize = EventDispatcher()

  var terminalKey: String = "" {
    didSet {
      accessibilityIdentifier = "t3-terminal-\(terminalKey)"
      if oldValue != terminalKey {
        // A different terminal shares none of this one's history or write
        // sequence. JS remounts on identity, so this only backstops reuse.
        //
        // 换了终端就不共享历史和写入序号。JS 侧会按身份重挂载，
        // 这里只是复用场景的兜底。
        replayBuffer = ""
        replayBufferBytes = 0
        appliedWriteSeq = 0
        resetSurface()
      }
    }
  }

  var bufferWrite = TerminalBufferWriteRecord() {
    didSet {
      applyBufferWrite(bufferWrite)
    }
  }

  var fontSize: CGFloat = 10 {
    didSet {
      guard oldValue != fontSize else { return }
      inputField.font = UIFont.monospacedSystemFont(ofSize: max(fontSize, 13), weight: .regular)
      refreshSurface()
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
      refreshSurface()
    }
  }

  var themeConfig: String = "" {
    didSet {
      guard oldValue != themeConfig else { return }
      refreshSurface()
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

    applyTheme()
    clipsToBounds = true
    contentScaleFactor = UIScreen.main.scale

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
    inputField.returnKeyType = .send
    inputField.keyboardType = .asciiCapable
    inputField.enablesReturnKeyAutomatically = false
    inputField.translatesAutoresizingMaskIntoConstraints = false
    inputField.alpha = 0.02
    inputField.isAccessibilityElement = false
    inputField.accessibilityElementsHidden = true
    inputField.addTarget(self, action: #selector(handleInputEditingDidBegin), for: .editingDidBegin)
    inputField.onDeleteBackward = { [weak self] in
      self?.emitInput("\u{7F}")
    }
    inputField.onInsert = { [weak self] data in
      self?.emitInput(data)
    }

    focusTapGesture.addTarget(self, action: #selector(handleViewportTap))
    terminalViewport.addGestureRecognizer(focusTapGesture)
    scrollPanGesture.addTarget(self, action: #selector(handleViewportPan(_:)))
    scrollPanGesture.maximumNumberOfTouches = 1
    scrollPanGesture.cancelsTouchesInView = false
    terminalViewport.addGestureRecognizer(scrollPanGesture)

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

  public func textField(_ textField: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String) -> Bool {
    if !string.isEmpty {
      // Some software keyboards deliver Return through this delegate instead of
      // textFieldShouldReturn, so normalize that path too.
      emitInput(TerminalInputSequence.normalizingReturn(string))
      return false
    }

    return false
  }

  public func textFieldShouldReturn(_ textField: UITextField) -> Bool {
    emitInput(TerminalInputSequence.carriageReturn)
    textField.text = ""
    return false
  }

  @objc
  private func handleViewportTap() {
    requestKeyboardFocus()
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

  @objc
  private func handleInputEditingDidBegin() {
    textInputModeDidChange()
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
      userdata: Unmanaged.passUnretained(self).toOpaque(),
      supports_selection_clipboard: false,
      wakeup_cb: { _ in },
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
    loadThemeConfig(into: config)
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
    replayBufferIntoSurface()
  }

  /// Rebuild the visible grid from retained output. Device queries inside the
  /// replayed bytes must not reach the live shell — they would land at the
  /// prompt as junk — so the surface's replies are dropped for the replay.
  ///
  /// 用保留的输出重建可见网格。重放数据里的设备查询不能发回正在运行的 shell，
  /// 否则会在提示符处变成乱码，所以重放期间丢弃 surface 的回复。
  private func replayBufferIntoSurface() {
    guard !replayBuffer.isEmpty else { return }
    isReplayingBuffer = true
    defer { isReplayingBuffer = false }
    feedData(Data(replayBuffer.utf8))
  }

  private func resetSurface() {
    destroySurface()
    lastViewportSize = .zero
    lastContentScale = 0
    lastReportedGrid = nil
    surfaceCreationFailed = false
    setNeedsLayout()
  }

  private func refreshSurface() {
    resetSurface()
    createSurfaceIfPossible()
  }

  private func destroySurface() {
    if let surface {
      ghostty_surface_set_write_callback(surface, nil, nil)
      ghostty_surface_free(surface)
    }
    if let app {
      ghostty_app_free(app)
    }
    surface = nil
    app = nil
  }

  /// Apply one incremental write from JS. Sequence numbers are monotonic, so a
  /// prop update the view has already consumed (re-render with unchanged data)
  /// is ignored rather than replayed.
  ///
  /// 应用 JS 侧的一次增量写入。序号单调递增，已消费过的 prop 更新
  /// （数据未变的重渲染）直接忽略，不会重放。
  private func applyBufferWrite(_ write: TerminalBufferWriteRecord) {
    guard write.seq > appliedWriteSeq else { return }
    appliedWriteSeq = write.seq

    if write.reset {
      replayBuffer = ""
      replayBufferBytes = 0
      // Clearing the live surface is cheaper than rebuilding it, and it keeps
      // the keyboard, selection, and scroll position intact.
      //
      // 清屏比重建 surface 便宜得多，而且能保住键盘、选区和滚动位置。
      feedData(Data(Self.clearScreenSequence.utf8))
    }

    appendToReplayBuffer(write.data)

    guard surface != nil else {
      // No surface yet (still unmeasured): the replay buffer carries the write
      // into the surface once layout creates it.
      //
      // surface 还没建（尚未布局完成）：写入先留在 replay buffer 里，
      // 等 surface 创建时一并喂入。
      createSurfaceIfPossible()
      return
    }

    feedData(Data(write.data.utf8))
  }

  private func appendToReplayBuffer(_ data: String) {
    guard !data.isEmpty else { return }
    replayBuffer += data
    replayBufferBytes += data.utf8.count

    guard replayBufferBytes > Self.maxReplayBufferBytes + Self.replayBufferTrimSlackBytes else {
      return
    }

    // Drop from the front on a UTF-8 boundary. Only replay depth is lost; the
    // scrollback the user sees lives in the terminal itself.
    //
    // 从头部按 UTF-8 边界裁剪。只损失重放深度，用户看到的滚动历史
    // 由终端自己持有。
    let utf8 = Array(replayBuffer.utf8)
    var start = utf8.count - Self.maxReplayBufferBytes
    while start < utf8.count, utf8[start] & 0b1100_0000 == 0b1000_0000 {
      start += 1
    }
    replayBuffer = String(decoding: utf8[start...], as: UTF8.self)
    replayBufferBytes = utf8.count - start
  }

  private func feedData(_ data: Data) {
    guard let surface, !data.isEmpty else { return }

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

    let userdata = Unmanaged.passUnretained(self).toOpaque()
    ghostty_surface_set_write_callback(surface, { userdata, data, len in
      guard let userdata, let data, len > 0 else { return }
      let view = Unmanaged<T3TerminalView>.fromOpaque(userdata).takeUnretainedValue()
      guard !view.isReplayingBuffer else { return }
      let bytes = Data(bytes: data, count: len)
      guard let input = String(data: bytes, encoding: .utf8), !input.isEmpty else { return }

      DispatchQueue.main.async {
        view.onInput(["data": input])
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
    ghostty_surface_set_occlusion(surface, window != nil)
    configureIOSurfaceLayers()
    redrawSurface()
    emitGhosttyResize()
  }

  private func redrawSurface() {
    guard let surface else { return }
    ghostty_surface_refresh(surface)
    ghostty_surface_draw(surface)
    markIOSurfaceLayersForDisplay()
    emitGhosttyResize()
  }

  private func emitGhosttyResize() {
    guard let surface else {
      emitEstimatedResize()
      return
    }

    let size = ghostty_surface_size(surface)
    let cols = max(1, Int(size.columns))
    let rows = max(1, Int(size.rows))
    emitResize(cols: cols, rows: rows)
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
    let scale = window?.screen.scale ?? UIScreen.main.scale
    if contentScaleFactor != scale {
      contentScaleFactor = scale
    }
  }

  private func requestKeyboardFocus() {
    guard window != nil else { return }
    inputField.becomeFirstResponder()
    textInputModeDidChange()
  }

  private func emitInput(_ data: String) {
    guard !data.isEmpty else { return }
    onInput(["data": data])
  }

  private func textInputModeDidChange() {
    guard let app else { return }
    ghostty_app_keyboard_changed(app)
  }

  private func configureIOSurfaceLayers() {
    let targetBounds = CGRect(origin: .zero, size: terminalViewport.bounds.size)
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

  private func loadThemeConfig(into config: ghostty_config_t) {
    guard let path = writeThemeConfigFile() else { return }
    path.withCString { cString in
      ghostty_config_load_file(config, cString)
    }
  }

  private func writeThemeConfigFile() -> String? {
    guard !themeConfig.isEmpty else { return nil }
    let configContents = themeConfig
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
