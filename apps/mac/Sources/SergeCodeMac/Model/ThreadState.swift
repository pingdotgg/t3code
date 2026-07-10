import Foundation
import Observation

public struct ComposerDraft: Equatable, Sendable {
    public var text: String
    public var attachments: [OutgoingAttachment]

    public init(text: String = "", attachments: [OutgoingAttachment] = []) {
        self.text = text
        self.attachments = attachments
    }

    public var isEmpty: Bool {
        text.isEmpty && attachments.isEmpty
    }
}

/// Per-thread UI state owned by `AppModel`. Each thread gets its own
/// `@Observable` instance so a mutation on thread B only invalidates views
/// that read thread B — not every view that happens to read some thread's
/// timeline/diff/etc through a shared dictionary on `AppModel`.
@Observable
@MainActor
public final class ThreadState {
    public internal(set) var timeline: [TimelineItem] = []
    public internal(set) var contextWindow: ContextWindowStatus?
    public internal(set) var planProgress: PlanProgress?
    public internal(set) var vcsStatus: VcsStatus?
    public internal(set) var diff: [DiffFile]?
    public internal(set) var checkpoints: [Checkpoint]?
    public internal(set) var composerDraft = ComposerDraft()

    /// Main-area review mode: when true, chat is swapped for DiffReviewView.
    public internal(set) var isReviewing = false
    public internal(set) var reviewScope: ReviewScope?
    public internal(set) var reviewSelectedPath: String?
    /// Diff files loaded for the active review scope (may differ from `diff`,
    /// which always holds the full-thread snapshot for the timeline rail).
    public internal(set) var reviewDiff: [DiffFile]?
    public internal(set) var isLoadingReviewDiff = false

    /// Monotonic version bumped on every timeline write. Grouped-display
    /// memo caches key on this so body re-evals without a timeline mutation
    /// reuse prior work. Ignored by Observation — readers go through
    /// `AppModel.timelineVersion(threadID:)`.
    @ObservationIgnored var timelineVersion = 0
    /// True once full history is present — either from `loadTimelineIfNeeded`
    /// or a `.timelineReset` snapshot. Plain appends/deltas do not set this,
    /// so a stream event for a not-yet-selected thread cannot suppress the
    /// later history fetch. Gates `loadTimelineIfNeeded`.
    @ObservationIgnored var hasLoadedTimeline = false

    public init() {}
}
