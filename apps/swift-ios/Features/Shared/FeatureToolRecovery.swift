import Foundation

/// An operation on a tool surface that can fail recoverably and be retried unchanged.
public protocol FeatureRecoverableOperation: Equatable, Sendable {
    /// Headline shown on the retained failure banner, e.g. "Push failed".
    var failureTitle: String { get }
    /// Stable accessibility label for the Retry control, e.g. "Retry push".
    var retryAccessibilityLabel: String { get }
    /// Spoken confirmation once the same operation succeeds.
    var recoveryAnnouncement: String { get }
}

/// Failure content retained for a tool surface. It survives the retry it triggers so the
/// useful output is never blanked while recovery is in flight.
public struct FeatureToolFailure: Identifiable, Sendable, Equatable, Hashable {
    /// Distinct per presented failure so a repeat failure can move accessibility focus again.
    public let id: Int
    public var title: String
    public var message: String
    public var retryAccessibilityLabel: String
    public var isRetrying: Bool

    public init(
        id: Int,
        title: String,
        message: String,
        retryAccessibilityLabel: String,
        isRetrying: Bool = false
    ) {
        self.id = id
        self.title = title
        self.message = message
        self.retryAccessibilityLabel = retryAccessibilityLabel
        self.isRetrying = isRetrying
    }

    /// Single spoken string so VoiceOver reads the retained content when focus lands on it.
    public var accessibilityLabel: String {
        isRetrying ? "\(title). \(message). Retrying." : "\(title). \(message)"
    }
}

/// Where accessibility focus belongs after a tool surface changes recovery state.
public enum FeatureToolRecoveryFocus: Hashable, Sendable {
    /// The retained failure summary, read together with its content.
    case failure
    /// The first element of the recovered content.
    case recoveredContent
}

/// Recovery state for one tool surface: keeps failure content visible across retries, refuses
/// to report cancellation as a failure, and names a predictable accessibility focus target.
public struct FeatureToolFailureState<Operation: FeatureRecoverableOperation>: Sendable, Equatable {
    public private(set) var failure: FeatureToolFailure?
    /// The exact operation to run again, including any input the failed attempt carried.
    public private(set) var retryOperation: Operation?
    /// Set once when an operation recovers, so the surface can announce it exactly once.
    public private(set) var recoveryAnnouncement: String?
    private var presentedFailureCount = 0

    public init() {}

    /// Marks an attempt as started. Retrying the failed operation keeps its content on screen
    /// instead of blanking it; unrelated work leaves the retained failure untouched.
    public mutating func begin(_ operation: Operation) {
        recoveryAnnouncement = nil
        guard failure != nil else { return }
        failure?.isRetrying = retryOperation == operation
    }

    /// Records the outcome of a failed attempt. Cancellation is not a failure: it never creates
    /// one and never overwrites content already on screen.
    public mutating func recordFailure(_ operation: Operation, error: Error) {
        guard !Self.isCancellation(error) else {
            failure?.isRetrying = false
            return
        }
        presentedFailureCount += 1
        failure = FeatureToolFailure(
            id: presentedFailureCount,
            title: operation.failureTitle,
            message: Self.message(for: error),
            retryAccessibilityLabel: operation.retryAccessibilityLabel
        )
        retryOperation = operation
    }

    /// Records a successful attempt. The recovered content replaces the failure rather than
    /// being stacked underneath it.
    public mutating func recordSuccess(_ operation: Operation) {
        let hadFailure = failure != nil
        failure = nil
        retryOperation = nil
        recoveryAnnouncement = hadFailure ? operation.recoveryAnnouncement : nil
    }

    /// Consumes the pending announcement so recovery is never spoken twice.
    public mutating func takeRecoveryAnnouncement() -> String? {
        defer { recoveryAnnouncement = nil }
        return recoveryAnnouncement
    }

    public var focusTarget: FeatureToolRecoveryFocus {
        failure == nil ? .recoveredContent : .failure
    }

    /// A dismissed sheet, a cancelled refresh, or a superseded request must not read as a failure.
    public static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain, nsError.code == NSURLErrorCancelled { return true }
        if nsError.domain == NSCocoaErrorDomain, nsError.code == NSUserCancelledError { return true }
        return false
    }

    private static func message(for error: Error) -> String {
        let described = error.localizedDescription
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return described.isEmpty ? "The operation could not be completed." : described
    }
}

/// The retryable work of the source control surface. `action` carries the commit message so a
/// retry never asks for it again.
public enum FeatureSourceControlOperation: FeatureRecoverableOperation {
    case load
    case action(FeatureSourceControlAction, message: String?)

    public var isLoad: Bool {
        if case .load = self { return true }
        return false
    }

    public var failureTitle: String {
        switch self {
        case .load: "Repository status failed to load"
        case .action(let action, _): "\(action.title) failed"
        }
    }

    public var retryAccessibilityLabel: String {
        switch self {
        case .load: "Retry loading repository status"
        case .action(let action, _): "Retry \(action.title.lowercased())"
        }
    }

    public var recoveryAnnouncement: String {
        switch self {
        case .load: "Repository status loaded."
        case .action(let action, _): "\(action.title) succeeded. Repository status updated."
        }
    }
}

public extension FeatureSourceControlAction {
    var title: String {
        switch self {
        case .commit: "Commit changes"
        case .push: "Push"
        case .pull: "Pull latest"
        case .createPullRequest: "Create pull request"
        case .commitAndPush: "Commit and push"
        case .commitPushAndCreatePullRequest: "Commit, push, and create PR"
        }
    }
}
