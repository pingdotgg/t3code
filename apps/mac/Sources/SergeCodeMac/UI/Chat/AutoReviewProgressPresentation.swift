import Foundation

enum AutoReviewThreadPresentation {
    static let fixerTitlePrefix = "Auto-review fixer · PR #"

    static func isDedicatedFixer(_ thread: ChatThread) -> Bool {
        guard let parent = thread.parentThreadId, !parent.isEmpty else { return false }
        return thread.title.hasPrefix(fixerTitlePrefix)
    }
}

/// The server-projected auto-review lifecycle shown on the active thread.
enum AutoReviewProgressPhase: String, CaseIterable, Sendable {
    case reviewing
    case fixing
    case readyToMerge

    init?(status: ThreadStatus) {
        switch status {
        case .reviewing: self = .reviewing
        case .fixing: self = .fixing
        case .readyToMerge: self = .readyToMerge
        case .idle, .running, .waiting, .waitingApproval, .waitingInput, .backgroundWork,
            .error, .archived, .settled, .done:
            return nil
        }
    }

    var stepIndex: Int {
        switch self {
        case .reviewing: 0
        case .fixing: 1
        case .readyToMerge: 2
        }
    }
}

/// Pure presentation policy for the compact auto-review progress surface.
enum AutoReviewProgressPresentation {
    static let title = "Auto review"

    static func headline(for phase: AutoReviewProgressPhase) -> String {
        switch phase {
        case .reviewing: "Reviewing pull request"
        case .fixing: "Addressing findings"
        case .readyToMerge: "Review clear"
        }
    }

    static func detail(for phase: AutoReviewProgressPhase) -> String {
        switch phase {
        case .reviewing: "Reviewer agent is inspecting the latest diff"
        case .fixing: "Auto-fixer is addressing review findings"
        case .readyToMerge: "No actionable comments remain"
        }
    }

    static func actionLabel(for phase: AutoReviewProgressPhase) -> String? {
        phase == .fixing ? "Open fixer" : nil
    }

    static func symbolName(for phase: AutoReviewProgressPhase) -> String {
        switch phase {
        case .reviewing: "text.magnifyingglass"
        case .fixing: "wrench.and.screwdriver.fill"
        case .readyToMerge: "checkmark.circle.fill"
        }
    }

    /// Terminal state persists in the thread model until merge, but the
    /// announcement should not permanently cover the transcript.
    static func dwell(for phase: AutoReviewProgressPhase) -> TimeInterval? {
        phase == .readyToMerge ? 8 : nil
    }

    static func accessibilityLabel(for phase: AutoReviewProgressPhase) -> String {
        "\(title), \(headline(for: phase)): \(detail(for: phase))"
    }
}
