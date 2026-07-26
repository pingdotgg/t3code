import Foundation
import Testing
import T3Kit

@testable import SergeCodeMac

// `turn.plan.updated` only ever carries steps — there is no "plan cleared"
// event — so the plan a turn produced has to be dropped when that turn
// settles. Otherwise the next turn opens with the previous turn's steps
// (usually a completed plan) in the rail above the composer.

@Suite("Plan progress lifecycle")
@MainActor
struct PlanProgressLifecycleTests {
    private func thread(_ id: String, status: ThreadStatus) -> ChatThread {
        ChatThread(
            id: id, projectID: "proj-1", title: "Thread \(id)", provider: .claudex,
            status: status, updatedAt: Date(), sessionStatus: status.rawValue)
    }

    private func progress(completed: Int, total: Int) -> PlanProgress {
        PlanProgress(
            steps: (0..<total).map {
                PlanStep(
                    id: $0, title: "Step \($0)",
                    status: $0 < completed ? .completed : .pending)
            },
            explanation: nil)
    }

    private func makeModel(_ id: String) -> AppModel {
        let model = AppModel(backend: MockBackend())
        model.enqueue(.threadUpserted(thread(id, status: .running)))
        model.enqueue(.planProgressUpdated(threadID: id, progress: progress(completed: 2, total: 3)))
        model.flushPendingEvents()
        return model
    }

    @Test("a settling turn drops the plan it produced")
    func settlingTurnClearsPlanProgress() {
        let model = makeModel("t-plan")
        #expect(model.threadState("t-plan")?.planProgress?.steps.count == 3)

        model.enqueue(.threadUpserted(thread("t-plan", status: .idle)))
        model.flushPendingEvents()

        #expect(model.threadState("t-plan")?.planProgress == nil)
    }

    @Test("background work is still a live turn, so the plan survives")
    func backgroundWorkKeepsPlanProgress() {
        let model = makeModel("t-bg")

        model.enqueue(.threadUpserted(thread("t-bg", status: .backgroundWork)))
        model.flushPendingEvents()

        #expect(model.threadState("t-bg")?.planProgress?.steps.count == 3)
    }

    @Test("a plan arriving just before the running upsert survives the turn start")
    func planAheadOfRunningUpsertSurvives() {
        let model = AppModel(backend: MockBackend())
        model.enqueue(.threadUpserted(thread("t-race", status: .idle)))
        model.enqueue(
            .planProgressUpdated(threadID: "t-race", progress: progress(completed: 0, total: 2)))
        model.enqueue(.threadUpserted(thread("t-race", status: .running)))
        model.flushPendingEvents()

        // Clearing on the start edge instead of the settle edge would have
        // wiped this plan before the rail ever showed it.
        #expect(model.threadState("t-race")?.planProgress?.steps.count == 2)
    }

    @Test("waiting on an approval is not a settle")
    func approvalWaitKeepsPlanProgress() {
        let model = makeModel("t-approval")

        model.enqueue(.threadUpserted(thread("t-approval", status: .waitingApproval)))
        model.flushPendingEvents()

        // `waitingApproval` is not a live turn, so the rail hides — but the
        // turn has not finished and its plan must come back with it.
        #expect(model.threadState("t-approval")?.planProgress?.steps.count == 3)
    }
}
