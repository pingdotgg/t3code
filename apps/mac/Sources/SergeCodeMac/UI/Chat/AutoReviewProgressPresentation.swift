import Foundation

enum AutoReviewThreadPresentation {
    static let fixerTitlePrefix = "Auto-review fixer · PR #"

    static func isDedicatedFixer(_ thread: ChatThread) -> Bool {
        guard let parent = thread.parentThreadId, !parent.isEmpty else { return false }
        return thread.title.hasPrefix(fixerTitlePrefix)
    }

    /// A fixer remains the active auto-review destination while it is paused
    /// for a human decision. The generic `isLiveTurn` predicate is intended
    /// for rendering and deliberately excludes those waiting states.
    static func isActiveFixerStatus(_ status: ThreadStatus) -> Bool {
        switch status {
        case .running, .waiting, .waitingApproval, .waitingInput, .backgroundWork:
            true
        case .idle, .error, .archived, .settled, .done, .reviewing, .fixing, .readyToMerge:
            false
        }
    }

    /// Pick the destination for an in-progress review when retries left more
    /// than one dedicated fixer child behind. Prefer a child that is doing
    /// work now or is waiting on a person, then the most recently updated
    /// child. The ID tie-breaker keeps the result stable when timestamps are
    /// equal.
    static func activeFixer(
        for parentID: String,
        in threads: [ChatThread]
    ) -> ChatThread? {
        threads
            .filter {
                $0.parentThreadId == parentID
                    && $0.status != .archived
                    && isDedicatedFixer($0)
            }
            .sorted {
                let firstIsActive = isActiveFixerStatus($0.status)
                let secondIsActive = isActiveFixerStatus($1.status)
                if firstIsActive != secondIsActive {
                    return firstIsActive
                }
                if $0.updatedAt != $1.updatedAt {
                    return $0.updatedAt > $1.updatedAt
                }
                return $0.id < $1.id
            }
            .first
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
