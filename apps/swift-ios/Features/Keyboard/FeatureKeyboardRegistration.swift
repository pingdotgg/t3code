import SwiftUI
import UIKit

extension View {
    /// Install once around the active navigation content, not in a background
    /// or overlay. The controller is an ancestor of the real text/terminal
    /// responders, so commands work without an invisible shortcut button or
    /// a competing first responder. Pass current navigation closures here.
    @MainActor
    func featureKeyboardCommands(
        dispatcher: FeatureKeyboardDispatcher,
        context: FeatureKeyboardContext,
        paletteContent: @escaping () -> FeatureCommandPaletteContent = { .init() },
        onPaletteQueryChange: @escaping (String) -> Void = { _ in },
        onCommand: @escaping (FeatureKeyboardCommand) -> Void
    ) -> some View {
        FeatureKeyboardHost(
            content: self,
            dispatcher: dispatcher,
            keyboardContext: context,
            paletteContent: paletteContent,
            onPaletteQueryChange: onPaletteQueryChange,
            onCommand: onCommand
        )
    }
}

private struct FeatureKeyboardHost<Content: View>: UIViewControllerRepresentable {
    let content: Content
    let dispatcher: FeatureKeyboardDispatcher
    let keyboardContext: FeatureKeyboardContext
    let paletteContent: () -> FeatureCommandPaletteContent
    let onPaletteQueryChange: (String) -> Void
    let onCommand: (FeatureKeyboardCommand) -> Void

    func makeUIViewController(context: Context) -> FeatureKeyboardHostingController {
        let controller = FeatureKeyboardHostingController(
            rootView: AnyView(content
                .environment(\.featureKeyboardDispatcher, dispatcher)
                .environment(\.self, context.environment)),
            dispatcher: dispatcher
        )
        updateDispatcher()
        return controller
    }

    func updateUIViewController(_ controller: FeatureKeyboardHostingController, context: Context) {
        updateDispatcher()
        controller.rootView = AnyView(content
            .environment(\.featureKeyboardDispatcher, dispatcher)
            .environment(\.self, context.environment))
        controller.refreshPalette()
    }

    static func dismantleUIViewController(_ controller: FeatureKeyboardHostingController, coordinator: ()) {
        controller.invalidate()
    }

    private func updateDispatcher() {
        dispatcher.update(
            context: keyboardContext,
            paletteContent: paletteContent,
            onPaletteQueryChange: onPaletteQueryChange,
            onCommand: onCommand
        )
    }
}

@MainActor
final class FeatureKeyboardHostingController: UIHostingController<AnyView> {
    private let dispatcher: FeatureKeyboardDispatcher
    private var palette: FeatureCommandPaletteController?
    private weak var previousFirstResponder: UIView?

    init(rootView: AnyView, dispatcher: FeatureKeyboardDispatcher) {
        self.dispatcher = dispatcher
        super.init(rootView: rootView)
        dispatcher.presentPalette = { [weak self] in self?.openPalette() }
        dispatcher.dismissPalette = { [weak self] action in
            if let palette = self?.palette { palette.close(action: action) }
            else { action() }
        }
        for name in [
            UITextView.textDidEndEditingNotification,
            UITextField.textDidEndEditingNotification,
            UIApplication.didBecomeActiveNotification,
        ] {
            NotificationCenter.default.addObserver(
                self, selector: #selector(reclaimAvailableResponder), name: name, object: nil
            )
        }
    }

    @MainActor required dynamic init?(coder aDecoder: NSCoder) { nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    override var canBecomeFirstResponder: Bool { true }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        reclaimAvailableResponder()
    }

    private var canHandleCommands: Bool {
        guard viewIfLoaded?.window != nil, palette == nil else { return false }
        var controller: UIViewController? = self
        while let current = controller {
            if let presented = current.presentedViewController {
                // A tool sheet can register a scope on its own existing
                // controller. It uses this same dispatcher and palette host.
                var top = presented
                while let next = top.presentedViewController { top = next }
                var active = dispatcher.activePresenter
                while let candidate = active {
                    if candidate === top { return true }
                    active = candidate.parent
                }
                return false
            }
            controller = current.parent
        }
        return true
    }

    override var keyCommands: [UIKeyCommand]? {
        guard canHandleCommands else { return super.keyCommands }
        return (super.keyCommands ?? []) + FeatureKeyboardShortcut.available(
            in: dispatcher.context,
            isPad: traitCollection.userInterfaceIdiom == .pad
        ).map { shortcut in
            let command = UIKeyCommand(
                input: shortcut.input,
                modifierFlags: shortcut.modifiers,
                action: #selector(handleCommand(_:))
            )
            command.discoverabilityTitle = shortcut.command.title
            command.wantsPriorityOverSystemBehavior = true
            return command
        }
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(handleCommand(_:)) {
            guard canHandleCommands, !hasMarkedText else { return false }
            return sender is UIKeyCommand ? resolve(sender as? UIKeyCommand) != nil : true
        }
        return super.canPerformAction(action, withSender: sender)
    }

    private var hasMarkedText: Bool {
        (view.window?.featureKeyboardFirstResponder as? any UITextInput)?.markedTextRange != nil
    }

    private func resolve(_ sender: UIKeyCommand?) -> FeatureKeyboardCommand? {
        guard let sender else { return nil }
        return FeatureKeyboardShortcut.available(
            in: dispatcher.context,
            isPad: traitCollection.userInterfaceIdiom == .pad
        ).first { $0.input == sender.input && $0.modifiers == sender.modifierFlags }?.command
    }

    @objc private func handleCommand(_ sender: UIKeyCommand) {
        guard canHandleCommands, !hasMarkedText, let command = resolve(sender) else { return }
        dispatcher.perform(command)
    }

    @objc private func reclaimAvailableResponder() {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.canHandleCommands,
                  self.view.window?.featureKeyboardFirstResponder == nil else { return }
            self.becomeFirstResponder()
        }
    }

    private func openPalette() {
        guard canHandleCommands, !hasMarkedText else { return }
        previousFirstResponder = view.window?.featureKeyboardFirstResponder
        let palette = FeatureCommandPaletteController(dispatcher: dispatcher) { [weak self] action in
            guard let self else { return }
            self.palette = nil
            self.dispatcher.search("")
            let previous = self.previousFirstResponder
            self.previousFirstResponder = nil
            if let action {
                action()
            } else if let previous, let window = self.view.window,
                      previous.window === window,
                      window.featureKeyboardFirstResponder == nil {
                // Only cancellation restores the editor. A selected action
                // owns navigation and any new focus request.
                previous.becomeFirstResponder()
            }
            self.reclaimAvailableResponder()
        }
        self.palette = palette
        palette.modalPresentationStyle = .formSheet
        palette.preferredContentSize = CGSize(width: 600, height: 520)
        (dispatcher.activePresenter ?? self).present(palette, animated: true)
    }

    func refreshPalette() {
        palette?.reloadResults()
    }

    func invalidate() {
        dispatcher.update(context: .init(enabledCommands: []), paletteContent: { .init() }, onCommand: { _ in })
        dispatcher.presentPalette = nil
        dispatcher.dismissPalette = nil
    }
}

extension UIView {
    var featureKeyboardFirstResponder: UIView? {
        if isFirstResponder { return self }
        for subview in subviews {
            if let responder = subview.featureKeyboardFirstResponder { return responder }
        }
        return nil
    }
}
