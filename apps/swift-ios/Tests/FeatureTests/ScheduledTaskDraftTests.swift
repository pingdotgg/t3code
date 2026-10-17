import XCTest
@testable import T3Code

@MainActor
final class ScheduledTaskDraftTests: XCTestCase {
    func testEditPreservesBoundThreadWorkspaceOptionsAndCreator() throws {
        let task = try ScheduledTaskTestFixtures.task()
        let project = project(environmentID: "remote")
        var draft = FeatureScheduledTaskDraft(environmentID: "remote", task: task, project: project)
        draft.title = " Updated title "
        let input = try draft.input(projects: [project])
        XCTAssertEqual(input.title, "Updated title")
        XCTAssertEqual(input.id, task.id)
        XCTAssertEqual(input.requireExisting, true)
        XCTAssertEqual(input.projectId, "project-local")
        XCTAssertEqual(input.threadId, "thread-local")
        XCTAssertEqual(input.schedule, task.schedule)
        XCTAssertEqual(input.workspaceStrategy, task.workspaceStrategy)
        XCTAssertEqual(input.modelSelection, task.modelSelection)
        XCTAssertEqual(input.runtimeMode, .autoAcceptEdits)
        XCTAssertEqual(input.interactionMode, .plan)
        XCTAssertEqual(input.createdBy, .agent)
        XCTAssertEqual(input.creationSource, .mcp)
    }

    func testCreateRetryKeepsIdentityAndUsesRawProjectId() throws {
        let project = project(environmentID: "remote")
        var draft = FeatureScheduledTaskDraft(environmentID: "remote", project: project,
            selection: .init(providerID: "custom-provider", modelID: "custom-model"), commandID: "create-once")
        draft.title = "Daily check"
        draft.prompt = "Check changes"
        let first = try draft.input(projects: [project])
        let retry = try draft.input(projects: [project])
        XCTAssertEqual(first.commandId, "create-once")
        XCTAssertEqual(first, retry)
        XCTAssertNil(first.requireExisting)
        XCTAssertNil(first.id)
        XCTAssertNil(first.threadId)
        XCTAssertEqual(first.creationSource, .mobile)
        XCTAssertEqual(first.projectId, "project-local")
        XCTAssertNotEqual(first.projectId, project.id)
    }

    func testProjectCannotCrossEnvironmentsOrMoveABoundThread() throws {
        let task = try ScheduledTaskTestFixtures.task()
        let remote = project(environmentID: "remote")
        let local = project(environmentID: "local")
        var draft = FeatureScheduledTaskDraft(environmentID: "remote", task: task, project: remote)
        draft.projectID = local.id
        XCTAssertThrowsError(try draft.input(projects: [remote, local]))
        let other = FeatureProject(id: "other", wireID: "other-wire", environmentID: "remote", name: "Other", path: "/other")
        draft.projectID = other.id
        XCTAssertThrowsError(try draft.input(projects: [remote, other]))
        draft.projectID = remote.id
        XCTAssertThrowsError(try draft.input(projects: []))
    }

    func testMissingWireIdNeverSendsAScopedProjectIdButLegacyRawIdsStillWork() throws {
        let task = try ScheduledTaskTestFixtures.task()
        var scoped = project(environmentID: "remote")
        scoped.wireID = nil
        let draft = FeatureScheduledTaskDraft(environmentID: "remote", task: task, project: scoped)
        XCTAssertThrowsError(try draft.input(projects: [scoped]))
        let legacy = FeatureProject(id: "project-local", environmentID: "remote", name: "Legacy", path: "/project")
        let legacyDraft = FeatureScheduledTaskDraft(environmentID: "remote", task: task, project: legacy)
        XCTAssertEqual(try legacyDraft.input(projects: [legacy]).projectId, "project-local")
    }

    func testIntervalValidationRejectsLegacyWriteAndNonFiniteOrUnsafeNumbers() throws {
        var draft = FeatureScheduledTaskDraft(environmentID: "remote")
        draft.scheduleMode = .interval
        for value in ["0.5", "0", "-1", "nan", "inf", "1e300", "", "minutes"] {
            draft.intervalMinutes = value
            XCTAssertThrowsError(try draft.schedule(), "Accepted \(value)")
        }
        draft.intervalMinutes = "1.5"
        XCTAssertEqual(try draft.schedule(), .interval(everyMs: 90_000))
        let legacy = try JSONValue.object([
            "type": .string("interval"), "everyMs": .number(30_000),
        ]).decode(ScheduledTaskSchedule.self)
        XCTAssertEqual(legacy, .interval(everyMs: 30_000))
    }

    func testFixedScheduleRequiresAValidHostTimeAndAtLeastOneWeekday() throws {
        var draft = FeatureScheduledTaskDraft(environmentID: "remote")
        draft.timeOfDay = "9:05"
        draft.weekdays = [6, 0, 3]
        XCTAssertEqual(try draft.schedule(), .fixedTime(timeOfDay: "9:05", weekdays: [0, 3, 6]))
        draft.weekdays = Set(0...6)
        XCTAssertEqual(try draft.schedule(), .fixedTime(timeOfDay: "9:05", weekdays: nil))
        for time in ["24:00", "12:60", "9:5", "00:00:00", "9:00\ninvalid"] {
            draft.timeOfDay = time
            XCTAssertThrowsError(try draft.schedule())
        }
        draft.timeOfDay = "09:00"
        draft.weekdays = []
        XCTAssertThrowsError(try draft.schedule())
        draft.weekdays = [7]
        XCTAssertThrowsError(try draft.schedule())
    }

    func testAllWorkspaceChoicesPreserveBranchAndValidateRequiredFields() throws {
        var draft = FeatureScheduledTaskDraft(environmentID: "remote")
        draft.branch = " scheduled "
        draft.workspace = .root
        XCTAssertEqual(try draft.workspaceStrategy(), .root(branch: "scheduled"))
        draft.workspace = .existingWorktree
        XCTAssertThrowsError(try draft.workspaceStrategy())
        draft.checkoutPath = " /repos/existing "
        XCTAssertEqual(try draft.workspaceStrategy(), .existingWorktree(worktreePath: "/repos/existing", branch: "scheduled"))
        draft.workspace = .worktree
        draft.startFromOrigin = false
        XCTAssertEqual(try draft.workspaceStrategy(), .worktree(baseRef: "main", branch: "scheduled", startFromOrigin: false))
        draft.baseRef = " "
        XCTAssertThrowsError(try draft.workspaceStrategy())
    }

    func testFallbackDoesNotHideAuthenticationOrTaskNotFoundErrors() {
        XCTAssertTrue(FeatureScheduledTaskError.isUnsupportedRPC(
            RPCError.remote("Unsupported method scheduledTasks.subscribe"), method: "scheduledTasks.subscribe"))
        for message in ["Unsupported authentication scheme for scheduledTasks.subscribe", "Task not found",
                        "Unknown method scheduledTasks.runNow", "Forbidden scheduledTasks.subscribe"] {
            XCTAssertFalse(FeatureScheduledTaskError.isUnsupportedRPC(
                RPCError.remote(message), method: "scheduledTasks.subscribe"))
        }
    }

    private func project(environmentID: String) -> FeatureProject {
        FeatureProject(id: FeatureScopedID.project(environmentID: environmentID, wireID: "project-local"),
                       wireID: "project-local", environmentID: environmentID, name: "Project", path: "/project")
    }
}
