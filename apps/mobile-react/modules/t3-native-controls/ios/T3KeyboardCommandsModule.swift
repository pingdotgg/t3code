import ExpoModulesCore
import UIKit

public final class T3KeyboardCommandsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("T3KeyboardCommands")

    View(T3KeyboardCommandsView.self) {
      Prop("enabledCommands") { (view: T3KeyboardCommandsView, commands: [String]) in
        view.setEnabledCommands(commands)
      }
      Events("onCommand")
    }
  }
}

public final class T3KeyboardCommandsView: ExpoView {
  let onCommand = EventDispatcher()
  private var enabledCommands = Set<String>()

  public override var canBecomeFirstResponder: Bool { true }

  public override var keyCommands: [UIKeyCommand]? {
    [
      enabledCommand("newTask", input: "n", modifiers: .command, action: #selector(newTask), title: "New Task"),
      enabledCommand("focusSearch", input: "f", modifiers: .command, action: #selector(focusSearch), title: "Find"),
      enabledCommand("focusSearch", input: "k", modifiers: .command, action: #selector(focusSearch), title: "Focus Search"),
      enabledCommand("back", input: "[", modifiers: .command, action: #selector(goBack), title: "Back"),
      enabledCommand("files", input: "f", modifiers: [.command, .shift], action: #selector(openFiles), title: "Open Files"),
      enabledCommand("terminal", input: "t", modifiers: [.command, .shift], action: #selector(openTerminal), title: "Open Terminal"),
      enabledCommand("review", input: "r", modifiers: [.command, .shift], action: #selector(openReview), title: "Open Review"),
      enabledCommand("toggleSidebar", input: "\\", modifiers: .command, action: #selector(handleToggleSidebar), title: "Toggle Sidebar"),
    ].compactMap { $0 }
  }

  func setEnabledCommands(_ commands: [String]) {
    enabledCommands = Set(commands)
    if isFirstResponder {
      resignFirstResponder()
    }
    reclaimFirstResponderIfAvailable()
  }

  private func enabledCommand(
    _ identifier: String,
    input: String,
    modifiers: UIKeyModifierFlags,
    action: Selector,
    title: String
  ) -> UIKeyCommand? {
    guard enabledCommands.contains(identifier) else { return nil }
    return command(input, modifiers: modifiers, action: action, title: title)
  }

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(reclaimFirstResponderIfAvailable),
      name: UITextView.textDidEndEditingNotification,
      object: nil
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(reclaimFirstResponderIfAvailable),
      name: UITextField.textDidEndEditingNotification,
      object: nil
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(reclaimFirstResponderIfAvailable),
      name: UIApplication.didBecomeActiveNotification,
      object: nil
    )
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    reclaimFirstResponderIfAvailable()
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    reclaimFirstResponderIfAvailable()
  }

  private func command(
    _ input: String,
    modifiers: UIKeyModifierFlags,
    action: Selector,
    title: String
  ) -> UIKeyCommand {
    let command = UIKeyCommand(input: input, modifierFlags: modifiers, action: action)
    command.discoverabilityTitle = title
    command.wantsPriorityOverSystemBehavior = true
    return command
  }

  @objc private func newTask() { emit("newTask") }
  @objc private func focusSearch() { emit("focusSearch") }
  @objc private func goBack() { emit("back") }
  @objc private func openFiles() { emit("files") }
  @objc private func openTerminal() { emit("terminal") }
  @objc private func openReview() { emit("review") }
  @objc private func handleToggleSidebar() { emit("toggleSidebar") }

  private func emit(_ command: String) {
    onCommand(["command": command])
  }

  @objc private func reclaimFirstResponderIfAvailable() {
    DispatchQueue.main.async { [weak self] in
      guard let self, self.window?.t3FirstResponder == nil else { return }
      self.becomeFirstResponder()
    }
  }
}

private extension UIView {
  var t3FirstResponder: UIResponder? {
    if isFirstResponder { return self }
    for subview in subviews {
      if let responder = subview.t3FirstResponder { return responder }
    }
    return nil
  }
}
