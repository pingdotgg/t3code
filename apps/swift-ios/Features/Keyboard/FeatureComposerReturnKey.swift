import UIKit

public enum FeatureComposerEnterBehavior: String, CaseIterable, Sendable, Codable {
    case send
    case newline

    public var title: String {
        switch self {
        case .send: "Send message"
        case .newline: "Insert new line"
        }
    }

    public var explanation: String {
        switch self {
        case .send: "Return sends the message. Shift-Return inserts a new line."
        case .newline: "Return inserts a new line. Command-Return sends the message."
        }
    }
}

enum FeatureComposerHardwareReturnPolicy {
    enum Action: Equatable {
        case submit(alternate: Bool)
        case newline
    }

    /// Only hardware commands call this policy. Software Return and IME
    /// confirmation stay with UITextView. The extra modifier selects the
    /// alternate queue/steer action in either preference mode, as in RN.
    static func action(
        behavior: FeatureComposerEnterBehavior,
        modifiers: UIKeyModifierFlags
    ) -> Action? {
        switch (behavior, modifiers) {
        case (.send, []): .submit(alternate: false)
        case (.send, .command): .submit(alternate: true)
        case (.send, .shift): .newline
        case (.newline, .command): .submit(alternate: false)
        case (.newline, [.command, .shift]): .submit(alternate: true)
        default: nil
        }
    }

    @MainActor
    static func commands(
        behavior: FeatureComposerEnterBehavior,
        submitTitle: String,
        alternateSubmitTitle: String,
        target: Selector
    ) -> [UIKeyCommand] {
        let modifiers: [UIKeyModifierFlags] = [[], .command, .shift, [.command, .shift]]
        return modifiers.compactMap { modifiers in
            guard let action = action(behavior: behavior, modifiers: modifiers) else { return nil }
            let command = UIKeyCommand(input: "\r", modifierFlags: modifiers, action: target)
            switch action {
            case .submit(let alternate):
                command.discoverabilityTitle = alternate ? alternateSubmitTitle : submitTitle
            case .newline:
                command.discoverabilityTitle = "New Line"
            }
            command.wantsPriorityOverSystemBehavior = true
            return command
        }
    }
}
