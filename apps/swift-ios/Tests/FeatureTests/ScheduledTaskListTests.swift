import XCTest
@testable import T3Code

@MainActor
final class ScheduledTaskListTests: XCTestCase {
    func testRotationReplacesLiveURLAndDeletionRemovesIt() async throws {
        let task = try ScheduledWebhookFixtures.row(url: "https://hooks.example/old").decode(ScheduledTask.self)
        let updated = try ScheduledWebhookFixtures.row(url: "https://hooks.example/new").decode(ScheduledTask.self)
        let client = ScheduledTaskFeatureClient(tasks: [task])
        client.rotatedTask = updated
        let model = FeatureScheduledTaskListModel(environmentID: "remote", client: client)
        await model.refresh()
        await model.runNow(task)
        XCTAssertTrue(client.actions.isEmpty)
        await model.rotateWebhookToken(task)
        XCTAssertEqual(model.task(id: task.id)?.webhook?.url, "https://hooks.example/new")
        XCTAssertEqual(client.actions, [.init(target: .init(environmentID: "remote", taskID: task.id), kind: "rotate")])
        client.snapshots = [.init(tasks: [], receivesLiveUpdates: true)]
        await model.observe()
        XCTAssertNil(model.task(id: task.id)?.webhook)
    }

    func testCompleteSnapshotsReplaceDeletedTasks() async throws {
        let task = try ScheduledTaskTestFixtures.task()
        let client = ScheduledTaskFeatureClient(tasks: [task])
        client.snapshots = [
            .init(tasks: [task], receivesLiveUpdates: true),
            .init(tasks: [], receivesLiveUpdates: true),
        ]
        let model = FeatureScheduledTaskListModel(environmentID: "remote", client: client)
        await model.observe()
        XCTAssertEqual(model.tasks, [])
        XCTAssertNil(model.loadError)
        XCTAssertEqual(client.subscribedEnvironments, ["remote"])
    }

    func testActionsKeepTheOwningEnvironmentWhenServersShareTaskIDs() async throws {
        let task = try ScheduledTaskTestFixtures.task()
        let client = ScheduledTaskFeatureClient(tasks: [task])
        let local = FeatureScheduledTaskListModel(environmentID: "local", client: client)
        let remote = FeatureScheduledTaskListModel(environmentID: "remote", client: client)
        await local.setEnabled(task, enabled: false)
        await remote.setEnabled(task, enabled: true)
        await remote.runNow(task)
        await local.delete(task)
        XCTAssertEqual(client.actions, [
            .init(target: .init(environmentID: "local", taskID: task.id), kind: "enabled:false"),
            .init(target: .init(environmentID: "remote", taskID: task.id), kind: "enabled:true"),
            .init(target: .init(environmentID: "remote", taskID: task.id), kind: "run"),
            .init(target: .init(environmentID: "local", taskID: task.id), kind: "delete"),
        ])
        XCTAssertEqual(client.listedEnvironments, ["local", "remote", "remote", "local"])
        XCTAssertTrue(local.pendingIDs.isEmpty)
        XCTAssertTrue(remote.pendingIDs.isEmpty)
        XCTAssertNotEqual(FeatureScheduledTaskTarget(environmentID: "local", taskID: task.id),
                          FeatureScheduledTaskTarget(environmentID: "remote", taskID: task.id))
    }

    func testReadFailureRetainsVisibleTasksAndMakesRetryAvailable() async throws {
        let task = try ScheduledTaskTestFixtures.task()
        let client = ScheduledTaskFeatureClient(tasks: [task])
        let model = FeatureScheduledTaskListModel(environmentID: "remote", client: client)
        await model.refresh()
        client.listError = RPCError.disconnected
        await model.refresh()
        XCTAssertEqual(model.tasks, [task])
        XCTAssertNotNil(model.loadError)
        XCTAssertFalse(model.isUnsupported)
        client.listError = nil
        await model.refresh()
        XCTAssertNil(model.loadError)
    }

    func testUnsupportedServiceIsDifferentFromOfflineOrAnEmptyList() async {
        let client = ScheduledTaskFeatureClient(tasks: [])
        client.listError = FeatureScheduledTaskError.unsupported
        let model = FeatureScheduledTaskListModel(environmentID: "legacy", client: client)
        await model.refresh()
        XCTAssertTrue(model.isUnsupported)
        XCTAssertNil(model.tasks)
        XCTAssertNotNil(model.loadError)
    }
}

@MainActor
private final class ScheduledTaskFeatureClient: FeatureScheduledTaskManaging {
    struct Action: Equatable { let target: FeatureScheduledTaskTarget; let kind: String }
    var rotatedTask: ScheduledTask?
    var tasks: [ScheduledTask]
    var snapshots: [FeatureScheduledTaskSnapshot] = []
    var listError: (any Error)?
    var actions: [Action] = []
    var subscribedEnvironments: [String] = []
    var listedEnvironments: [String] = []

    init(tasks: [ScheduledTask]) { self.tasks = tasks }

    func listScheduledTasks(environmentID: String) async throws -> [ScheduledTask] {
        listedEnvironments.append(environmentID)
        if let listError { throw listError }
        return tasks
    }

    func scheduledTaskUpdates(environmentID: String) -> AsyncThrowingStream<FeatureScheduledTaskSnapshot, Error> {
        subscribedEnvironments.append(environmentID)
        return AsyncThrowingStream { continuation in
            snapshots.forEach { continuation.yield($0) }
            continuation.finish()
        }
    }

    func upsertScheduledTask(environmentID: String, input: ScheduledTaskUpsertInput) async throws -> ScheduledTask {
        throw FeatureScheduledTaskError.unsupported
    }

    func setScheduledTaskEnabled(_ target: FeatureScheduledTaskTarget, enabled: Bool) async throws -> ScheduledTask {
        actions.append(.init(target: target, kind: "enabled:\(enabled)"))
        return try XCTUnwrap(tasks.first)
    }

    func runScheduledTaskNow(_ target: FeatureScheduledTaskTarget) async throws -> ScheduledTask {
        actions.append(.init(target: target, kind: "run"))
        return try XCTUnwrap(tasks.first)
    }

    func rotateScheduledTaskWebhookToken(_ target: FeatureScheduledTaskTarget) async throws -> ScheduledTask {
        actions.append(.init(target: target, kind: "rotate"))
        let task = try XCTUnwrap(rotatedTask)
        tasks = [task]
        return task
    }

    func deleteScheduledTask(_ target: FeatureScheduledTaskTarget) async throws {
        actions.append(.init(target: target, kind: "delete"))
    }
}
