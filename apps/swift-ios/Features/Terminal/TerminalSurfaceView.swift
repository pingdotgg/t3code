import GhosttyKit
import QuartzCore
import SwiftUI
import UIKit

struct GhosttyTerminalSurface: UIViewRepresentable {
    @SwiftUI.Environment(\.colorScheme) private var colorScheme
    let terminalKey: String
    let buffer: String
    let fontSize: CGFloat
    let isRunning: Bool
    let focusRequest: Int
    let onInput: (String) -> Void
    let onResize: (Int, Int) -> Void
    let onClear: () -> Void
    let onFontSizeStep: (Int) -> Void

    func makeUIView(context _: Context) -> GhosttyTerminalView {
        let view = GhosttyTerminalView()
        configure(view)
        return view
    }

    func updateUIView(_ view: GhosttyTerminalView, context _: Context) {
        configure(view)
    }

    private func configure(_ view: GhosttyTerminalView) {
        view.isDarkMode = colorScheme == .dark
        view.onInput = onInput
        view.onResize = onResize
        view.onClear = onClear
        view.onFontSizeStep = onFontSizeStep
        view.terminalKey = terminalKey
        view.fontSize = fontSize
        view.isRunning = isRunning
        view.buffer = buffer
        view.focusRequest = focusRequest
    }
}

enum TerminalText {
    static func plainText(from value: String) -> String {
        let withoutEscapes = value
            .replacingOccurrences(
                of: "\u{1B}\\][^\u{7}\u{1B}]*(?:\u{7}|\u{1B}\\\\)",
                with: "",
                options: .regularExpression
            )
            .replacingOccurrences(
                of: "\u{1B}\\[[0-?]*[ -/]*[@-~]",
                with: "",
                options: .regularExpression
            )
            .replacingOccurrences(
                of: "\u{1B}[@-_]",
                with: "",
                options: .regularExpression
            )

        return withoutEscapes.reduce(into: "") { output, character in
            if character == "\u{8}" || character == "\u{7F}" {
                if !output.isEmpty { output.removeLast() }
                return
            }
            if character == "\r" { return }
            if character.unicodeScalars.count == 1,
               let scalar = character.unicodeScalars.first,
               scalar.value < 32,
               character != "\n",
               character != "\t" {
                return
            }
            output.append(character)
        }
    }
}

private enum GhosttyRuntime {
    private static let lock = NSLock()
    private static var initialized = false

    static func ensureInitialized() -> Bool {
        lock.lock()
        defer { lock.unlock() }

        if initialized { return true }
        initialized = ghostty_init(0, nil) == GHOSTTY_SUCCESS
        return initialized
    }
}

private enum TerminalHardwareKeyEncoder {
    private static let controlInputs = "abcdefghijklmnopqrstuvwxyz@[\\]^_-? "

    static func makeKeyCommands(action: Selector) -> [UIKeyCommand] {
        var commands = [UIKeyCommand]()
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
            commands.append(
                makeCommand(
                    input: String(character),
                    modifierFlags: .control,
                    action: action
                )
            )
            commands.append(
                makeCommand(
                    input: String(character),
                    modifierFlags: [.control, .shift],
                    action: action
                )
            )
        }

        commands.append(makeCommand(input: "c", modifierFlags: .command, action: action))
        commands.append(makeCommand(input: "v", modifierFlags: .command, action: action))
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
        if modifiers == .command {
            return input.lowercased() == "c" ? "copy" : input.lowercased() == "v" ? "paste" : nil
        }

        switch input {
        case UIKeyCommand.inputEscape: return "\u{1B}"
        case UIKeyCommand.inputUpArrow: return "\u{1B}[A"
        case UIKeyCommand.inputDownArrow: return "\u{1B}[B"
        case UIKeyCommand.inputRightArrow: return "\u{1B}[C"
        case UIKeyCommand.inputLeftArrow: return "\u{1B}[D"
        case "\t": return modifiers.contains(.shift) ? "\u{1B}[Z" : "\t"
        default: break
        }

        guard modifiers.contains(.control),
              let scalar = input.lowercased().unicodeScalars.first else {
            return nil
        }
        return controlSequence(for: scalar)
    }

    static func applyingControl(to input: String) -> String {
        guard let scalar = input.lowercased().unicodeScalars.first else { return input }
        return controlSequence(for: scalar) ?? input
    }

    private static func controlSequence(for scalar: Unicode.Scalar) -> String? {
        switch scalar {
        case "a"..."z": return UnicodeScalar(scalar.value - 96).map(String.init)
        case " ", "@": return "\u{00}"
        case "[": return "\u{1B}"
        case "\\": return "\u{1C}"
        case "]": return "\u{1D}"
        case "^": return "\u{1E}"
        case "_", "-": return "\u{1F}"
        case "?": return "\u{7F}"
        default: return nil
        }
    }
}

private final class TerminalInputField: UITextField {
    var onDeleteBackward: (() -> Void)?
    var onInsert: ((String) -> Void)?
    var onCopyOutput: (() -> Void)?
    var onPasteText: (() -> Void)?

    private static let terminalKeyCommands = TerminalHardwareKeyEncoder.makeKeyCommands(
        action: #selector(handleHardwareKeyCommand(_:))
    )

    override var keyCommands: [UIKeyCommand]? { Self.terminalKeyCommands }

    override func deleteBackward() {
        onDeleteBackward?()
        super.deleteBackward()
    }

    @objc private func handleHardwareKeyCommand(_ command: UIKeyCommand) {
        guard let input = command.input,
              let sequence = TerminalHardwareKeyEncoder.sequence(
                input: input,
                modifiers: command.modifierFlags
              ) else {
            return
        }

        if sequence == "copy" {
            onCopyOutput?()
        } else if sequence == "paste" {
            onPasteText?()
        } else {
            onInsert?(sequence)
        }
    }
}

private enum TerminalAccessoryAction: String {
    case escape
    case command
    case control
    case tab
    case clear
    case up
    case down
    case left
    case right
    case tilde
    case pipe
    case slash
    case dash
    case dismiss

    var label: String {
        switch self {
        case .escape: "esc"
        case .command: "cmd"
        case .control: "ctrl"
        case .tab: "tab"
        case .clear: "clear"
        case .up: "↑"
        case .down: "↓"
        case .left: "←"
        case .right: "→"
        case .tilde: "~"
        case .pipe: "|"
        case .slash: "/"
        case .dash: "-"
        case .dismiss: ""
        }
    }

    var sequence: String? {
        switch self {
        case .escape: "\u{1B}"
        case .tab: "\t"
        case .up: "\u{1B}[A"
        case .down: "\u{1B}[B"
        case .left: "\u{1B}[D"
        case .right: "\u{1B}[C"
        case .tilde: "~"
        case .pipe: "|"
        case .slash: "/"
        case .dash: "-"
        case .command, .control, .clear, .dismiss: nil
        }
    }

    var width: CGFloat {
        switch self {
        case .escape, .tab: 44
        case .command: 48
        case .control, .clear: 50
        case .up, .down, .left, .right, .tilde, .pipe, .slash, .dash: 38
        case .dismiss: 36
        }
    }
}

private final class TerminalAccessoryButton: UIButton {
    let terminalAction: TerminalAccessoryAction

    init(action: TerminalAccessoryAction) {
        terminalAction = action
        super.init(frame: .zero)
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { nil }
}

private final class TerminalAccessoryView: UIInputView {
    private let scrollView = UIScrollView()
    private let stackView = UIStackView()
    private let dismissButton = TerminalAccessoryButton(action: .dismiss)
    private var actionButtons = [TerminalAccessoryAction: TerminalAccessoryButton]()
    private var activeModifier: TerminalAccessoryAction?
    var onAction: ((TerminalAccessoryAction) -> Void)?

    init() {
        super.init(frame: CGRect(x: 0, y: 0, width: 0, height: 50), inputViewStyle: .keyboard)
        allowsSelfSizing = true
        backgroundColor = T3Colors.uiBackground

        scrollView.showsHorizontalScrollIndicator = false
        scrollView.alwaysBounceHorizontal = true
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        stackView.axis = .horizontal
        stackView.alignment = .center
        stackView.spacing = 7
        stackView.translatesAutoresizingMaskIntoConstraints = false

        addSubview(scrollView)
        addSubview(dismissButton)
        scrollView.addSubview(stackView)

        let actions: [TerminalAccessoryAction] = [
            .escape, .command, .control, .tab, .clear,
            .up, .down, .left, .right, .tilde, .pipe, .slash, .dash,
        ]
        for action in actions {
            let button = TerminalAccessoryButton(action: action)
            configure(button, label: action.label)
            actionButtons[action] = button
            stackView.addArrangedSubview(button)
        }

        dismissButton.accessibilityLabel = "Dismiss keyboard"
        dismissButton.addTarget(self, action: #selector(handleButton(_:)), for: .touchUpInside)
        dismissButton.translatesAutoresizingMaskIntoConstraints = false

        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 50),
            scrollView.leadingAnchor.constraint(equalTo: leadingAnchor),
            scrollView.topAnchor.constraint(equalTo: topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: bottomAnchor),
            scrollView.trailingAnchor.constraint(equalTo: dismissButton.leadingAnchor),
            dismissButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -4),
            dismissButton.centerYAnchor.constraint(equalTo: centerYAnchor),
            dismissButton.widthAnchor.constraint(equalToConstant: TerminalAccessoryAction.dismiss.width),
            dismissButton.heightAnchor.constraint(equalToConstant: 42),
            stackView.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor, constant: 8),
            stackView.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor, constant: -8),
            stackView.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor),
            stackView.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor),
            stackView.heightAnchor.constraint(equalTo: scrollView.frameLayoutGuide.heightAnchor),
        ])
        refreshAppearance()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) {
            (self: Self, _: UITraitCollection) in
            self.refreshAppearance()
        }
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { nil }

    func setRunning(_ running: Bool) {
        for (action, button) in actionButtons {
            button.isEnabled = running || action == .clear
        }
    }

    func setActiveModifier(_ action: TerminalAccessoryAction?) {
        activeModifier = action
        for modifier in [TerminalAccessoryAction.command, .control] {
            guard let button = actionButtons[modifier] else { continue }
            applyStyle(to: button, active: modifier == action)
        }
    }

    func refreshAppearance() {
        backgroundColor = T3Colors.uiBackground
        for (action, button) in actionButtons {
            applyStyle(to: button, active: action == activeModifier)
        }

        var dismissConfiguration = UIButton.Configuration.plain()
        dismissConfiguration.image = UIImage(systemName: "keyboard.chevron.compact.down")
        dismissConfiguration.baseForegroundColor = .secondaryLabel
        dismissConfiguration.contentInsets = .zero
        dismissButton.configuration = dismissConfiguration
    }

    private func configure(_ button: TerminalAccessoryButton, label: String) {
        button.setTitle(label.uppercased(), for: .normal)
        button.titleLabel?.font = .systemFont(ofSize: 10, weight: .semibold)
        button.accessibilityLabel = label
        button.addTarget(self, action: #selector(handleButton(_:)), for: .touchUpInside)
        button.translatesAutoresizingMaskIntoConstraints = false
        button.heightAnchor.constraint(equalToConstant: 34).isActive = true
        button.widthAnchor.constraint(equalToConstant: button.terminalAction.width).isActive = true
        applyStyle(to: button, active: false)
    }

    private func applyStyle(to button: UIButton, active: Bool) {
        var configuration = UIButton.Configuration.plain()
        if let terminalButton = button as? TerminalAccessoryButton,
           terminalButton.terminalAction != .dismiss {
            configuration.title = terminalButton.terminalAction.label.uppercased()
        }
        let isDark = traitCollection.userInterfaceStyle == .dark
        configuration.baseForegroundColor = if active {
            isDark ? UIColor(white: 0.04, alpha: 1) : .white
        } else {
            isDark ? UIColor(white: 0.88, alpha: 1) : T3Colors.uiTextPrimary
        }
        configuration.background.backgroundColor = if active {
            isDark ? UIColor(white: 0.94, alpha: 1) : T3Colors.uiTextPrimary
        } else {
            isDark ? UIColor(white: 0.08, alpha: 1) : .white
        }
        configuration.background.cornerRadius = 7
        configuration.background.strokeColor = isDark
            ? UIColor(white: active ? 0.55 : 0.20, alpha: 1)
            : UIColor(white: 0, alpha: active ? 0.18 : 0.10)
        configuration.background.strokeWidth = 1
        configuration.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer {
            var attributes = $0
            attributes.font = .systemFont(ofSize: 10, weight: .semibold)
            return attributes
        }
        configuration.contentInsets = NSDirectionalEdgeInsets(
            top: 0,
            leading: 4,
            bottom: 0,
            trailing: 4
        )
        button.configuration = configuration
    }

    @objc private func handleButton(_ sender: TerminalAccessoryButton) {
        onAction?(sender.terminalAction)
    }
}

final class GhosttyTerminalView: UIView, UITextFieldDelegate, UIContextMenuInteractionDelegate {
    private static let minimumVerticalScrollStepPoints: CGFloat = 18
    private static let verticalScrollStepMultiplier: CGFloat = 1.15
    private static let darkThemeConfig = """
    background = #0a0a0a
    foreground = #adadb1
    cursor-color = #009fff
    cursor-text = #0a0a0a
    cursor-style-blink = false
    palette = 0=#141415
    palette = 1=#ff2e3f
    palette = 2=#0dbe4e
    palette = 3=#ffca00
    palette = 4=#009fff
    palette = 5=#c635e4
    palette = 6=#08c0ef
    palette = 7=#c6c6c8
    palette = 8=#141415
    palette = 9=#ff2e3f
    palette = 10=#0dbe4e
    palette = 11=#ffca00
    palette = 12=#009fff
    palette = 13=#c635e4
    palette = 14=#08c0ef
    palette = 15=#c6c6c8
    """
    private static let lightThemeConfig = """
    background = #f2f2f7
    foreground = #6c6c71
    cursor-color = #009fff
    cursor-text = #f2f2f7
    cursor-style-blink = false
    palette = 0=#1f1f21
    palette = 1=#ff2e3f
    palette = 2=#0dbe4e
    palette = 3=#ffca00
    palette = 4=#009fff
    palette = 5=#c635e4
    palette = 6=#08c0ef
    palette = 7=#c6c6c8
    palette = 8=#1f1f21
    palette = 9=#ff2e3f
    palette = 10=#0dbe4e
    palette = 11=#ffca00
    palette = 12=#009fff
    palette = 13=#c635e4
    palette = 14=#08c0ef
    palette = 15=#c6c6c8
    """

    var onInput: ((String) -> Void)?
    var onResize: ((Int, Int) -> Void)?
    var onClear: (() -> Void)?
    var onFontSizeStep: ((Int) -> Void)?

    var isDarkMode = true {
        didSet {
            guard oldValue != isDarkMode else { return }
            applyChromeAppearance()
            refreshSurface()
        }
    }

    var terminalKey = "" {
        didSet {
            accessibilityIdentifier = "t3-terminal-\(terminalKey)"
            inputField.accessibilityIdentifier = "t3-terminal-input-\(terminalKey)"
            guard oldValue != terminalKey else { return }
            pendingModifier = nil
            resetSurface()
        }
    }

    var buffer = "" {
        didSet {
            guard oldValue != buffer else { return }
            applyRemoteBuffer(buffer)
        }
    }

    var fontSize: CGFloat = 10.5 {
        didSet {
            guard oldValue != fontSize else { return }
            inputField.font = .monospacedSystemFont(ofSize: max(fontSize, 13), weight: .regular)
            refreshSurface()
        }
    }

    var isRunning = false {
        didSet {
            guard oldValue != isRunning else { return }
            inputField.isEnabled = isRunning
            accessoryView.setRunning(isRunning)
            keyboardButton.isHidden = !isRunning || inputField.isFirstResponder
            if isRunning, window != nil, !hasAutoFocused {
                hasAutoFocused = true
                DispatchQueue.main.async { [weak self] in self?.requestKeyboardFocus() }
            } else if !isRunning {
                pendingModifier = nil
            }
        }
    }

    var focusRequest = 0 {
        didSet {
            guard oldValue != focusRequest else { return }
            DispatchQueue.main.async { [weak self] in self?.requestKeyboardFocus() }
        }
    }

    private let terminalViewport = UIView()
    private let inputField = TerminalInputField()
    private let accessoryView = TerminalAccessoryView()
    private let keyboardButton = UIButton(type: .system)
    private let focusTapGesture = UITapGestureRecognizer()
    private let scrollPanGesture = UIPanGestureRecognizer()
    private let fontPinchGesture = UIPinchGestureRecognizer()
    private var pendingModifier: TerminalAccessoryAction? {
        didSet { accessoryView.setActiveModifier(pendingModifier) }
    }
    private var lastViewportSize: CGSize = .zero
    private var lastContentScale: CGFloat = 0
    private var lastReportedGrid: (columns: Int, rows: Int)?
    private var lastAppliedBuffer = ""
    private var isReplayingBuffer = false
    private var pendingVerticalScrollPoints: CGFloat = 0
    private var hasAutoFocused = false
    private var app: ghostty_app_t?
    private var surface: ghostty_surface_t?
    private var isCreatingSurface = false
    private var surfaceCreationFailed = false

    init() {
        super.init(frame: .zero)
        clipsToBounds = true
        contentScaleFactor = UIScreen.main.scale
        accessibilityLabel = "Terminal"

        terminalViewport.clipsToBounds = true
        terminalViewport.contentScaleFactor = contentScaleFactor
        terminalViewport.translatesAutoresizingMaskIntoConstraints = false
        terminalViewport.isUserInteractionEnabled = true

        inputField.delegate = self
        inputField.inputAccessoryView = accessoryView
        inputField.backgroundColor = .clear
        inputField.textColor = .clear
        inputField.tintColor = .clear
        inputField.font = .monospacedSystemFont(ofSize: max(fontSize, 13), weight: .regular)
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
        inputField.isAccessibilityElement = true
        inputField.accessibilityLabel = "Terminal input"
        inputField.addTarget(self, action: #selector(inputDidBegin), for: .editingDidBegin)
        inputField.addTarget(self, action: #selector(inputDidEnd), for: .editingDidEnd)
        inputField.onDeleteBackward = { [weak self] in self?.sendInput("\u{7F}") }
        inputField.onInsert = { [weak self] in self?.sendInput($0) }
        inputField.onCopyOutput = { [weak self] in self?.copyOutput() }
        inputField.onPasteText = { [weak self] in self?.pasteText() }

        keyboardButton.accessibilityLabel = "Show keyboard"
        keyboardButton.isHidden = true
        keyboardButton.translatesAutoresizingMaskIntoConstraints = false
        keyboardButton.addTarget(self, action: #selector(showKeyboard), for: .touchUpInside)

        accessoryView.onAction = { [weak self] in self?.handleAccessoryAction($0) }

        focusTapGesture.addTarget(self, action: #selector(viewportTapped))
        terminalViewport.addGestureRecognizer(focusTapGesture)

        scrollPanGesture.addTarget(self, action: #selector(viewportPanned(_:)))
        scrollPanGesture.maximumNumberOfTouches = 1
        scrollPanGesture.cancelsTouchesInView = false
        terminalViewport.addGestureRecognizer(scrollPanGesture)

        fontPinchGesture.addTarget(self, action: #selector(viewportPinched(_:)))
        terminalViewport.addGestureRecognizer(fontPinchGesture)
        terminalViewport.addInteraction(UIContextMenuInteraction(delegate: self))

        addSubview(terminalViewport)
        addSubview(inputField)
        addSubview(keyboardButton)

        NSLayoutConstraint.activate([
            terminalViewport.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 6),
            terminalViewport.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
            terminalViewport.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            terminalViewport.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -6),
            inputField.trailingAnchor.constraint(equalTo: trailingAnchor),
            inputField.topAnchor.constraint(equalTo: bottomAnchor, constant: 8),
            inputField.widthAnchor.constraint(equalToConstant: 1),
            inputField.heightAnchor.constraint(equalToConstant: 1),
            keyboardButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
            keyboardButton.bottomAnchor.constraint(equalTo: safeAreaLayoutGuide.bottomAnchor, constant: -16),
            keyboardButton.widthAnchor.constraint(equalToConstant: 48),
            keyboardButton.heightAnchor.constraint(equalToConstant: 48),
        ])
        applyChromeAppearance()
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { nil }

    deinit { destroySurface() }

    override func layoutSubviews() {
        super.layoutSubviews()
        updateContentScale()
        if surface == nil { createSurfaceIfPossible() }

        let viewportSize = terminalViewport.bounds.size
        guard viewportSize != lastViewportSize || contentScaleFactor != lastContentScale else {
            return
        }
        lastViewportSize = viewportSize
        lastContentScale = contentScaleFactor
        resizeSurface()
        inputField.accessibilityFrame = terminalViewport.convert(terminalViewport.bounds, to: nil)
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard window != nil, isRunning, !hasAutoFocused else { return }
        hasAutoFocused = true
        DispatchQueue.main.async { [weak self] in self?.requestKeyboardFocus() }
    }

    func textField(
        _: UITextField,
        shouldChangeCharactersIn _: NSRange,
        replacementString string: String
    ) -> Bool {
        if !string.isEmpty {
            sendInput(string == "\n" || string == "\r\n" ? "\r" : string)
        }
        return false
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        sendInput("\r")
        textField.text = ""
        return false
    }

    func contextMenuInteraction(
        _: UIContextMenuInteraction,
        configurationForMenuAtLocation _: CGPoint
    ) -> UIContextMenuConfiguration? {
        UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
            guard let self else { return UIMenu() }
            let copy = UIAction(title: "Copy output", image: UIImage(systemName: "doc.on.doc")) { [weak self] _ in
                self?.copyOutput()
            }
            let paste = UIAction(
                title: "Paste",
                image: UIImage(systemName: "doc.on.clipboard"),
                attributes: self.isRunning && UIPasteboard.general.hasStrings ? [] : .disabled
            ) { [weak self] _ in
                self?.pasteText()
            }
            let clear = UIAction(title: "Clear", image: UIImage(systemName: "eraser")) { [weak self] _ in
                self?.onClear?()
            }
            return UIMenu(children: [copy, paste, clear])
        }
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
        let ghosttyColorScheme =
            isDarkMode
            ? GHOSTTY_COLOR_SCHEME_DARK
            : GHOSTTY_COLOR_SCHEME_LIGHT
        ghostty_app_set_color_scheme(createdApp, ghosttyColorScheme)
        ghostty_surface_set_color_scheme(createdSurface, ghosttyColorScheme)
        setupWriteCallback()
        resizeSurface()
        feedBuffer(buffer)
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

    private func applyChromeAppearance() {
        let background =
            isDarkMode
            ? UIColor(red: 10 / 255, green: 10 / 255, blue: 10 / 255, alpha: 1)
            : UIColor(red: 242 / 255, green: 242 / 255, blue: 247 / 255, alpha: 1)
        backgroundColor = background
        terminalViewport.backgroundColor = background
        accessoryView.overrideUserInterfaceStyle = isDarkMode ? .dark : .light
        accessoryView.refreshAppearance()

        var keyboardConfiguration = UIButton.Configuration.filled()
        keyboardConfiguration.image = UIImage(systemName: "keyboard")
        keyboardConfiguration.baseForegroundColor = isDarkMode ? .white : T3Colors.uiTextPrimary
        keyboardConfiguration.baseBackgroundColor =
            isDarkMode ? UIColor(white: 0.10, alpha: 0.96) : .white
        keyboardConfiguration.background.cornerRadius = 24
        keyboardConfiguration.background.strokeColor =
            isDarkMode
            ? UIColor(white: 0.25, alpha: 1)
            : UIColor(white: 0, alpha: 0.10)
        keyboardConfiguration.background.strokeWidth = 1
        keyboardButton.configuration = keyboardConfiguration
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
        if let app { ghostty_app_free(app) }
        terminalViewport.layer.sublayers?.forEach { $0.removeFromSuperlayer() }
        surface = nil
        app = nil
    }

    private func applyRemoteBuffer(_ newBuffer: String) {
        guard surface != nil else {
            createSurfaceIfPossible()
            return
        }
        guard newBuffer != lastAppliedBuffer else { return }

        if newBuffer.isEmpty {
            feedData(Data("\u{1B}[2J\u{1B}[H".utf8))
            lastAppliedBuffer = ""
            return
        }

        if newBuffer.hasPrefix(lastAppliedBuffer) {
            feedData(Data(newBuffer.dropFirst(lastAppliedBuffer.count).utf8))
            lastAppliedBuffer = newBuffer
            return
        }

        resetSurface()
        createSurfaceIfPossible()
    }

    private func feedBuffer(_ value: String) {
        guard !value.isEmpty else { return }
        isReplayingBuffer = true
        defer { isReplayingBuffer = false }
        feedData(Data(value.utf8))
        lastAppliedBuffer = value
    }

    private func feedData(_ data: Data) {
        guard let surface, !data.isEmpty else { return }
        data.withUnsafeBytes { bytes in
            guard let pointer = bytes.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
            ghostty_surface_feed_data(surface, pointer, bytes.count)
        }
        redrawSurface()
    }

    private func setupWriteCallback() {
        guard let surface else { return }
        let userdata = Unmanaged.passUnretained(self).toOpaque()
        ghostty_surface_set_write_callback(surface, { userdata, data, length in
            guard let userdata, let data, length > 0 else { return }
            let view = Unmanaged<GhosttyTerminalView>.fromOpaque(userdata).takeUnretainedValue()
            guard !view.isReplayingBuffer else { return }
            let bytes = Data(bytes: data, count: length)
            guard let input = String(data: bytes, encoding: .utf8), !input.isEmpty else { return }
            DispatchQueue.main.async { view.onInput?(input) }
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
        emitResize(columns: max(1, Int(size.columns)), rows: max(1, Int(size.rows)))
    }

    private func emitEstimatedResize() {
        guard bounds.width > 0, bounds.height > 0 else { return }
        let columns = max(20, min(400, Int(bounds.width / max(fontSize * 0.62, 1))))
        let rows = max(5, min(200, Int(bounds.height / max(fontSize * 1.35, 1))))
        emitResize(columns: columns, rows: rows)
    }

    private func emitResize(columns: Int, rows: Int) {
        guard lastReportedGrid?.columns != columns || lastReportedGrid?.rows != rows else { return }
        lastReportedGrid = (columns, rows)
        onResize?(columns, rows)
    }

    private func updateContentScale() {
        let scale = window?.screen.scale ?? UIScreen.main.scale
        if contentScaleFactor != scale { contentScaleFactor = scale }
    }

    private func requestKeyboardFocus() {
        guard window != nil, isRunning else { return }
        inputField.becomeFirstResponder()
        if let surface { ghostty_surface_set_focus(surface, true) }
        if let app { ghostty_app_keyboard_changed(app) }
    }

    private func sendInput(_ data: String) {
        guard isRunning, !data.isEmpty else { return }
        let resolved: String
        if pendingModifier == .control {
            resolved = TerminalHardwareKeyEncoder.applyingControl(to: data)
        } else if pendingModifier == .command {
            resolved = "\u{1B}\(data)"
        } else {
            resolved = data
        }
        pendingModifier = nil
        onInput?(resolved)
    }

    private func copyOutput() {
        UIPasteboard.general.string = TerminalText.plainText(from: buffer)
    }

    private func pasteText() {
        guard let value = UIPasteboard.general.string, !value.isEmpty else { return }
        sendInput(value)
    }

    private func handleAccessoryAction(_ action: TerminalAccessoryAction) {
        switch action {
        case .command, .control:
            pendingModifier = pendingModifier == action ? nil : action
        case .clear:
            pendingModifier = nil
            onClear?()
        case .dismiss:
            pendingModifier = nil
            inputField.resignFirstResponder()
        default:
            if let sequence = action.sequence { sendInput(sequence) }
        }
    }

    private func configureIOSurfaceLayers() {
        let targetBounds = CGRect(origin: .zero, size: terminalViewport.bounds.size)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        terminalViewport.layer.sublayers?.forEach { layer in
            layer.frame = targetBounds
            layer.contentsScale = contentScaleFactor
        }
        CATransaction.commit()
    }

    private func markIOSurfaceLayersForDisplay() {
        terminalViewport.layer.setNeedsDisplay()
        terminalViewport.layer.sublayers?.forEach { $0.setNeedsDisplay() }
    }

    private func loadThemeConfig(into config: ghostty_config_t) {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-swiftui-terminal.ghostty")
        do {
            let themeConfig = isDarkMode ? Self.darkThemeConfig : Self.lightThemeConfig
            if (try? String(contentsOf: url, encoding: .utf8)) != themeConfig {
                try themeConfig.write(to: url, atomically: true, encoding: .utf8)
            }
            url.path.withCString { ghostty_config_load_file(config, $0) }
        } catch {
            // The default Ghostty configuration is still usable if the theme file cannot be staged.
        }
    }

    @objc private func viewportTapped() {
        requestKeyboardFocus()
    }

    @objc private func viewportPanned(_ gesture: UIPanGestureRecognizer) {
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
            let total = pendingVerticalScrollPoints + translation.y
            let steps = Int(total / stepSize)
            pendingVerticalScrollPoints = total - CGFloat(steps) * stepSize
            if steps != 0 {
                ghostty_surface_mouse_scroll(surface, 0, Double(steps), 0)
                redrawSurface()
            }
            gesture.setTranslation(.zero, in: terminalViewport)
        default:
            pendingVerticalScrollPoints = 0
            gesture.setTranslation(.zero, in: terminalViewport)
        }
    }

    @objc private func viewportPinched(_ gesture: UIPinchGestureRecognizer) {
        guard gesture.state == .ended else { return }
        if gesture.scale >= 1.08 {
            onFontSizeStep?(1)
        } else if gesture.scale <= 0.92 {
            onFontSizeStep?(-1)
        }
    }

    @objc private func inputDidBegin() {
        keyboardButton.isHidden = true
        if let surface { ghostty_surface_set_focus(surface, true) }
        if let app { ghostty_app_keyboard_changed(app) }
    }

    @objc private func inputDidEnd() {
        pendingModifier = nil
        keyboardButton.isHidden = !isRunning
        if let surface { ghostty_surface_set_focus(surface, false) }
    }

    @objc private func showKeyboard() {
        requestKeyboardFocus()
    }
}
