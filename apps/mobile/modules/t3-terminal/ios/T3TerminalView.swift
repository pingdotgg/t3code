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

private final class TerminalInputField: UITextField {
  var onDeleteBackward: (() -> Void)?

  override func deleteBackward() {
    onDeleteBackward?()
    super.deleteBackward()
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

  private let terminalViewport = UIView()
  private let inputField = TerminalInputField()
  private let focusTapGesture = UITapGestureRecognizer()
  private let scrollPanGesture = UIPanGestureRecognizer()
  private var lastViewportSize: CGSize = .zero
  private var lastContentScale: CGFloat = 0
  private var lastReportedGrid: (cols: Int, rows: Int)?
  private var lastAppliedBuffer = ""
  private var pendingVerticalScrollPoints: CGFloat = 0
  private var app: ghostty_app_t?
  private var surface: ghostty_surface_t?
  private var isCreatingSurface = false
  private var surfaceCreationFailed = false
  private var appearance = TerminalAppearanceScheme.dark
  private var backgroundColorValue = UIColor(hexString: "#24292e")

  let onInput = EventDispatcher()
  let onResize = EventDispatcher()

  var terminalKey: String = "" {
    didSet {
      accessibilityIdentifier = "t3-terminal-\(terminalKey)"
      if oldValue != terminalKey {
        resetSurface()
      }
    }
  }

  var initialBuffer: String = "" {
    didSet {
      applyRemoteBuffer(initialBuffer)
    }
  }

  var fontSize: CGFloat = 10 {
    didSet {
      guard oldValue != fontSize else { return }
      inputField.font = UIFont.monospacedSystemFont(ofSize: max(fontSize, 13), weight: .regular)
      refreshSurface()
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

    guard window != nil else { return }
    DispatchQueue.main.async { [weak self] in
      self?.requestKeyboardFocus()
    }
  }

  public func textField(_ textField: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String) -> Bool {
    if !string.isEmpty {
      emitInput(string)
      return false
    }

    return false
  }

  public func textFieldShouldReturn(_ textField: UITextField) -> Bool {
    emitInput("\n")
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
      read_clipboard_cb: { _, _, _ in false },
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
    feedBuffer(initialBuffer)
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

  private func applyRemoteBuffer(_ buffer: String) {
    guard surface != nil else {
      createSurfaceIfPossible()
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

  private func feedBuffer(_ buffer: String) {
    guard !buffer.isEmpty else { return }
    feedData(Data(buffer.utf8))
    lastAppliedBuffer = buffer
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
