import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Subagent inner thread")
@MainActor
struct SubagentInnerThreadTests {
    private let start = Date(timeIntervalSince1970: 1_700_000_000)

    private func task(
        id: String = "task-1",
        state: SubagentTaskState = .running,
        latestProgress: String? = nil,
        error: String? = nil,
        duration: TimeInterval? = nil,
        progressLog: [SubagentTaskProgressEntry] = []
    ) -> SubagentTaskItem {
        SubagentTaskItem(
            taskId: id, taskType: "explore", description: "Audit the timeline fold",
            subagentType: "Explore", model: "claude-sonnet-5",
            state: state, latestProgress: latestProgress, error: error,
            startedAt: start, duration: duration, progressLog: progressLog)
    }

    // MARK: - Result

    @Test("a running agent has no result to show or promote")
    func runningHasNoResult() {
        let running = task(latestProgress: "Reading files...")
        #expect(SubagentInnerThread.resultText(for: running) == nil)
        #expect(SubagentInnerThread.promotionText(for: running, modelDisplayNames: [:]) == nil)
    }

    @Test("a settled agent's result is its completion summary")
    func completedResultIsSummary() {
        let done = task(state: .completed, latestProgress: "Found 3 stale rows.", duration: 65)
        #expect(SubagentInnerThread.resultText(for: done) == "Found 3 stale rows.")
    }

    @Test("a failed agent with no summary falls back to its error")
    func failedResultFallsBackToError() {
        let failed = task(state: .failed, latestProgress: nil, error: "provider timeout")
        #expect(SubagentInnerThread.resultText(for: failed) == "provider timeout")
    }

    // MARK: - Promotion

    @Test("promotion quotes every result line and attributes the agent")
    func promotionQuotesResult() {
        let done = task(
            state: .completed,
            latestProgress: "Line one\n\nLine two",
            duration: 125)
        let text = SubagentInnerThread.promotionText(
            for: done, modelDisplayNames: ["claude-sonnet-5": "Sonnet 5"])
        let promotion = try! #require(text)

        #expect(promotion.contains("“Audit the timeline fold”"))
        #expect(promotion.contains("(Explore · Sonnet 5, 2m 5s)"))
        #expect(promotion.contains("> Line one"))
        // Blank lines stay blank quote lines, so the block reads as one quote.
        #expect(promotion.contains("> Line one\n>\n> Line two"))
    }

    // MARK: - Steering

    @Test("steering names the agent and its task id")
    func steerPrefillNamesTask() {
        let prefill = SubagentInnerThread.steerPrefill(for: task(id: "task-42"))
        #expect(prefill.contains("“Audit the timeline fold”"))
        #expect(prefill.contains("task-42"))
        #expect(prefill.hasSuffix(": "))
    }

    // MARK: - Header + tail

    @Test("state line counts up while running and freezes at the final duration")
    func stateLineTracksState() {
        let running = task()
        #expect(
            SubagentInnerThread.stateLine(for: running, at: start.addingTimeInterval(30))
                == "Running · 30s")

        let done = task(state: .completed, latestProgress: "done", duration: 65)
        #expect(
            SubagentInnerThread.stateLine(for: done, at: start.addingTimeInterval(600))
                == "Completed · 1m 5s")
    }

    @Test("only a running agent still streams a tail to follow")
    func followsTailOnlyWhileRunning() {
        #expect(SubagentInnerThread.followsTail(task()))
        #expect(!SubagentInnerThread.followsTail(task(state: .completed, latestProgress: "x")))
        #expect(SubagentInnerThread.isStoppable(task(state: .paused)))
        #expect(!SubagentInnerThread.isStoppable(task(state: .stopped)))
    }

    // MARK: - Navigation

    @Test("opening a task on another thread selects that thread first")
    func openSelectsOwningThread() {
        let model = AppModel(backend: MockBackend())
        model.selectedThreadID = "thread-a"
        model.subagentTaskAggregator.upsert(task(id: "task-b"), for: "thread-b")

        model.openSubagent(taskId: "task-b", threadID: "thread-b")

        #expect(model.selectedThreadID == "thread-b")
        #expect(model.focusedSubagentTask(threadID: "thread-b")?.taskId == "task-b")
        #expect(model.focusedSubagentTask(threadID: "thread-a") == nil)

        model.closeSubagent()
        #expect(model.focusedSubagentTask(threadID: "thread-b") == nil)
    }

    @Test("a drill-down leaves review mode, which owns the same pane")
    func openLeavesReviewMode() {
        let model = AppModel(backend: MockBackend())
        model.subagentTaskAggregator.upsert(task(), for: "thread-a")
        model.openReview(threadID: "thread-a", scope: .allChanges)

        model.openSubagent(taskId: "task-1", threadID: "thread-a")

        #expect(model.threadState("thread-a")?.isReviewing == false)
        #expect(model.focusedSubagentTask(threadID: "thread-a")?.taskId == "task-1")
    }

    @Test("focus survives progress updates but not a pruned task")
    func focusFollowsLiveTaskState() {
        let model = AppModel(backend: MockBackend())
        model.selectedThreadID = "thread-a"
        model.subagentTaskAggregator.upsert(task(), for: "thread-a")
        model.openSubagent(taskId: "task-1", threadID: "thread-a")

        model.subagentTaskAggregator.upsert(
            task(state: .completed, latestProgress: "all done", duration: 12), for: "thread-a")
        #expect(model.focusedSubagentTask(threadID: "thread-a")?.state == .completed)

        model.subagentTaskAggregator.remove(threadID: "thread-a")
        #expect(model.focusedSubagentTask(threadID: "thread-a") == nil)
    }

    // MARK: - Composer promotion

    @Test("promoting a result appends to the draft instead of clobbering it")
    func promotionAppendsToDraft() {
        let model = AppModel(backend: MockBackend())
        model.selectedThreadID = "thread-a"
        model.setComposerDraftText("Use this:", for: "thread-a")

        let done = task(state: .completed, latestProgress: "Found 3 stale rows.", duration: 12)
        let promotion = try! #require(
            SubagentInnerThread.promotionText(for: done, modelDisplayNames: [:]))
        model.stageComposerTextAppending(promotion)

        let draft = model.composerDraft(for: "thread-a").text
        #expect(draft.hasPrefix("Use this:\n\n"))
        #expect(draft.contains("> Found 3 stale rows."))
        // The composer only picks text up through a prefill.
        #expect(model.composerPrefill?.text == draft)
        #expect(model.composerPrefill?.editedMessageID == nil)
    }

    @Test("promoting into an empty draft does not lead with blank lines")
    func promotionIntoEmptyDraft() {
        let model = AppModel(backend: MockBackend())
        model.selectedThreadID = "thread-a"

        model.stageComposerTextAppending("Result from the agent")

        #expect(model.composerDraft(for: "thread-a").text == "Result from the agent")
    }
}
