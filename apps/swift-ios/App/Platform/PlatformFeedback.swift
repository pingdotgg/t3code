import UIKit

enum PlatformFeedbackKind: Equatable, Sendable {
    case success
    case warning
    case error
}

struct PlatformThreadSignal: Equatable, Sendable {
    let kind: PlatformFeedbackKind
    let thread: FeatureThread
}

enum PlatformThreadTransitionClassifier {
    /// Previous states are kept as a bare `[id: state]` map so each home
    /// revision retains a dictionary of enums, not a copy of every thread.
    static func signals(
        previous: [String: FeatureThreadState]?,
        current: [FeatureThread]
    ) -> [PlatformThreadSignal] {
        guard let previous else { return [] }

        return current.compactMap { thread in
            guard let oldState = previous[thread.id], oldState != thread.state else { return nil }
            let kind: PlatformFeedbackKind? = switch thread.state {
            case .waitingForApproval, .waitingForInput:
                .warning
            case .failed:
                .error
            case .completed where oldState == .working
                || oldState == .queued
                || oldState == .monitoring:
                .success
            default:
                nil
            }
            return kind.map { PlatformThreadSignal(kind: $0, thread: thread) }
        }
    }
}

@MainActor
final class PlatformHapticEngine {
    static let shared = PlatformHapticEngine()

    func emit(_ kind: PlatformFeedbackKind, enabled: Bool) {
        guard enabled else { return }
        let generator = UINotificationFeedbackGenerator()
        generator.prepare()
        switch kind {
        case .success:
            generator.notificationOccurred(.success)
        case .warning:
            generator.notificationOccurred(.warning)
        case .error:
            generator.notificationOccurred(.error)
        }
    }

    func selection(enabled: Bool) {
        guard enabled else { return }
        let generator = UISelectionFeedbackGenerator()
        generator.prepare()
        generator.selectionChanged()
    }
}
