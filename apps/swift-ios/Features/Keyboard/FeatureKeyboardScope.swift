import SwiftUI
import UIKit

private struct FeatureKeyboardDispatcherKey: EnvironmentKey {
    static let defaultValue: FeatureKeyboardDispatcher? = nil
}

struct FeatureThreadPresentationDismissal {
    var requestID: UUID?
    var onPresentationChange: (UUID, Bool) -> Void = { _, _ in }
}

/// A route resumes once both the thread sheet and any nested transcript
/// previews report dismissal. A newer route replaces the pending token.
struct FeatureRootNavigationDismissal {
    private(set) var requestID: UUID?
    private var waitingForPresentation = false
    private var childPresentations: Set<UUID> = []

    mutating func request(_ id: UUID, hasPresentation: Bool) {
        requestID = id
        waitingForPresentation = waitingForPresentation || hasPresentation
    }

    mutating func presentationDidDismiss() {
        waitingForPresentation = false
    }

    mutating func presentationDidAppear() {
        waitingForPresentation = true
    }

    mutating func childPresentationChanged(_ id: UUID, isPresented: Bool) {
        if isPresented { childPresentations.insert(id) }
        else { childPresentations.remove(id) }
    }

    mutating func takeReadyRequest() -> UUID? {
        guard !waitingForPresentation, childPresentations.isEmpty else { return nil }
        defer { requestID = nil }
        return requestID
    }
}

private struct FeatureThreadPresentationDismissalKey: EnvironmentKey {
    static var defaultValue: FeatureThreadPresentationDismissal { .init() }
}

extension EnvironmentValues {
    var featureKeyboardDispatcher: FeatureKeyboardDispatcher? {
        get { self[FeatureKeyboardDispatcherKey.self] }
        set { self[FeatureKeyboardDispatcherKey.self] = newValue }
    }

    var featureThreadPresentationDismissal: FeatureThreadPresentationDismissal {
        get { self[FeatureThreadPresentationDismissalKey.self] }
        set { self[FeatureThreadPresentationDismissalKey.self] = newValue }
    }
}

extension View {
    /// Supplies active screen actions to the one Workspace dispatcher. This
    /// scope never takes focus or adds another root responder/palette. Tool
    /// sheets forward native commands through their existing controller.
    @MainActor
    func featureKeyboardScope(
        id: String,
        isActive: Bool = true,
        enabledCommands: Set<FeatureKeyboardCommand>,
        isTerminalActive: Bool = false,
        beforeRootAction: ((@escaping @MainActor () -> Void) -> Void)? = nil,
        onCommand: @escaping (FeatureKeyboardCommand) -> Void
    ) -> some View {
        modifier(FeatureKeyboardScopeModifier(
            id: id,
            isActive: isActive,
            context: FeatureKeyboardContext(
                enabledCommands: enabledCommands,
                isTerminalActive: isTerminalActive
            ),
            beforeRootAction: beforeRootAction,
            onCommand: onCommand
        ))
    }
}

private struct FeatureKeyboardScopeModifier: ViewModifier {
    @SwiftUI.Environment(\.featureKeyboardDispatcher) private var dispatcher
    @State private var isVisible = false
    let id: String
    let isActive: Bool
    let context: FeatureKeyboardContext
    let beforeRootAction: ((@escaping @MainActor () -> Void) -> Void)?
    let onCommand: (FeatureKeyboardCommand) -> Void

    func body(content: Content) -> some View {
        content.background {
            FeatureKeyboardScopeRegistration(
                dispatcher: dispatcher,
                isActive: isActive && isVisible,
                context: context,
                beforeRootAction: beforeRootAction,
                onCommand: onCommand
            )
            .id(id)
            .frame(width: 0, height: 0)
        }
        .onAppear { isVisible = true }
        .onDisappear { isVisible = false }
    }
}

/// A lifecycle marker, with no controls or responder overrides. Updating it
/// refreshes closures even when command availability has not changed.
private struct FeatureKeyboardScopeRegistration: UIViewRepresentable {
    let dispatcher: FeatureKeyboardDispatcher?
    let isActive: Bool
    let context: FeatureKeyboardContext
    let beforeRootAction: ((@escaping @MainActor () -> Void) -> Void)?
    let onCommand: (FeatureKeyboardCommand) -> Void

    func makeUIView(context: Context) -> FeatureKeyboardScopeView {
        let view = FeatureKeyboardScopeView()
        view.isUserInteractionEnabled = false
        view.isAccessibilityElement = false
        return view
    }

    func updateUIView(_ view: FeatureKeyboardScopeView, context: Context) {
        if view.dispatcher !== dispatcher { view.unregister() }
        view.dispatcher = dispatcher
        view.isActive = isActive
        view.context = self.context
        view.onCommand = onCommand
        view.beforeRootAction = beforeRootAction
        view.updateRegistration()
    }

    static func dismantleUIView(_ view: FeatureKeyboardScopeView, coordinator: ()) {
        view.unregister()
    }
}

private final class FeatureKeyboardScopeView: UIView {
    private let registrationID = UUID()
    private weak var commandController: UIViewController?
    private var installedCommands: [UIKeyCommand] = []
    private var installedContext: FeatureKeyboardContext?
    weak var dispatcher: FeatureKeyboardDispatcher?
    var isActive = false
    var context = FeatureKeyboardContext(enabledCommands: [])
    var onCommand: (FeatureKeyboardCommand) -> Void = { _ in }
    var beforeRootAction: ((@escaping @MainActor () -> Void) -> Void)?

    override func didMoveToWindow() {
        super.didMoveToWindow()
        updateRegistration()
    }

    func updateRegistration() {
        guard isActive, window != nil else {
            unregister()
            return
        }
        var responder: UIResponder? = next
        while responder != nil && !(responder is UIViewController) { responder = responder?.next }
        let presenter = responder as? UIViewController
        dispatcher?.updateScope(id: registrationID, context: context, presenter: presenter,
            beforeRootAction: beforeRootAction, onCommand: onCommand)

        // Normal detail content is already inside the Workspace host. Native
        // sheets have a separate responder chain, so register on their real
        // controller instead of adding another hidden responder or host.
        var ancestor = presenter
        while let controller = ancestor {
            if controller is FeatureKeyboardHostingController {
                removeCommands()
                return
            }
            ancestor = controller.parent
        }
        guard let presenter, let dispatcher else { return }
        guard commandController !== presenter || installedContext != dispatcher.context else { return }
        removeCommands()
        commandController = presenter
        installedContext = dispatcher.context
        FeatureKeyboardScopeRelay.registrations.setObject(self, forKey: registrationID.uuidString as NSString)
        installedCommands = FeatureKeyboardShortcut.available(
            in: dispatcher.context, isPad: traitCollection.userInterfaceIdiom == .pad
        ).map { shortcut in
            let command = UIKeyCommand(
                title: shortcut.command.title,
                action: #selector(UIResponder.featureKeyboardScopeCommand(_:)),
                input: shortcut.input,
                modifierFlags: shortcut.modifiers,
                propertyList: registrationID.uuidString
            )
            command.discoverabilityTitle = shortcut.command.title
            command.wantsPriorityOverSystemBehavior = true
            presenter.addKeyCommand(command)
            return command
        }
    }

    func unregister() {
        removeCommands()
        dispatcher?.removeScope(id: registrationID)
    }

    private func removeCommands() {
        for command in installedCommands { commandController?.removeKeyCommand(command) }
        installedCommands = []
        installedContext = nil
        commandController = nil
        FeatureKeyboardScopeRelay.registrations.removeObject(forKey: registrationID.uuidString as NSString)
    }

    func perform(_ sender: UIKeyCommand) {
        guard isActive, let window, let dispatcher,
              let commandController, FeatureKeyboardPresentation.isTop(commandController),
              (window.featureKeyboardFirstResponder as? any UITextInput)?.markedTextRange == nil,
              let command = FeatureKeyboardShortcut.available(
                in: dispatcher.context, isPad: traitCollection.userInterfaceIdiom == .pad
              ).first(where: { $0.input == sender.input && $0.modifiers == sender.modifierFlags }) else { return }
        dispatcher.perform(command.command)
    }
}

@MainActor
private enum FeatureKeyboardScopeRelay {
    // Weak values ensure a removed SwiftUI scope cannot retain a screen.
    static let registrations = NSMapTable<NSString, FeatureKeyboardScopeView>.strongToWeakObjects()
}

private extension UIResponder {
    /// The command carries its registration ID because UIKit may resolve this
    /// selector on a text view before reaching the controller that owns it.
    @objc func featureKeyboardScopeCommand(_ sender: UIKeyCommand) {
        guard let id = sender.propertyList as? String else { return }
        FeatureKeyboardScopeRelay.registrations.object(forKey: id as NSString)?.perform(sender)
    }
}
