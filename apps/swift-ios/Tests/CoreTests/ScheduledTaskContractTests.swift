import Foundation
import XCTest
@testable import T3Code

final class ScheduledTaskContractTests: XCTestCase {
    func testWorkspaceUnionKeepsBranchPathAndOriginOnTheWire() throws {
        let values = [
            #"{"type":"root"}"#,
            #"{"type":"root","branch":"release"}"#,
            #"{"type":"existing_worktree","worktreePath":"/repos/task","branch":"task"}"#,
            #"{"type":"worktree","baseRef":"main"}"#,
            #"{"type":"worktree","baseRef":"release","branch":"task","startFromOrigin":false}"#,
            #"{"type":"worktree","baseRef":"main","startFromOrigin":true}"#,
        ]
        for value in values {
            let raw = try JSONDecoder.t3.decode(JSONValue.self, from: Data(value.utf8))
            let workspace = try raw.decode(ScheduledTaskWorkspaceStrategy.self)
            XCTAssertEqual(try JSONValue.encode(workspace), raw)
        }
    }

    func testScheduleUnionReadsLegacyIntervalsAndBothDailyForms() throws {
        for value in [
            #"{"type":"interval","everyMs":30000}"#,
            #"{"type":"interval","everyMs":61001}"#,
            #"{"type":"fixed_time","timeOfDay":"09:30"}"#,
            #"{"type":"fixed_time","timeOfDay":"9:30","weekdays":[]}"#,
            #"{"type":"fixed_time","timeOfDay":"18:15","weekdays":[0,2,6]}"#,
        ] {
            let raw = try JSONDecoder.t3.decode(JSONValue.self, from: Data(value.utf8))
            let schedule = try raw.decode(ScheduledTaskSchedule.self)
            XCTAssertEqual(try JSONValue.encode(schedule), raw)
        }
    }

    func testListRetainsBoundThreadRunStateAndCreationIdentity() throws {
        let list = try JSONValue.object(["tasks": .array([ScheduledTaskTestFixtures.taskJSON])])
            .decode(ScheduledTaskListResult.self)
        let task = try XCTUnwrap(list.tasks.first)
        XCTAssertEqual(task.projectId, "project-local")
        XCTAssertEqual(task.threadId, "thread-local")
        XCTAssertEqual(task.modelSelection.instanceId, "provider-custom")
        XCTAssertEqual(task.modelSelection.options?.first?.value, .string("high"))
        XCTAssertEqual(task.createdBy, .agent)
        XCTAssertEqual(task.creationSource, .mcp)
        XCTAssertEqual(task.lastRunStatus, .failed)
        XCTAssertEqual(task.lastRunError, "Provider is offline")
        XCTAssertEqual(task.runCount, 4)
        XCTAssertEqual(task.nextRunAt, "2026-10-05T16:00:00.000Z")
    }

    func testUnknownUnionCaseFailsInsteadOfChangingTheScheduleOrWorkspace() throws {
        let unknown: JSONValue = .object(["type": .string("future")])
        XCTAssertThrowsError(try unknown.decode(ScheduledTaskWorkspaceStrategy.self))
        XCTAssertThrowsError(try unknown.decode(ScheduledTaskSchedule.self))
    }
}

enum ScheduledTaskTestFixtures {
    static let taskJSON: JSONValue = .object([
        "id": .string("task-local"), "title": .string("Review changes"), "prompt": .string("Review recent commits"),
        "enabled": .bool(true), "schedule": .object(["type": .string("interval"), "everyMs": .number(61001)]),
        "projectId": .string("project-local"), "threadId": .string("thread-local"),
        "workspaceStrategy": .object([
            "type": .string("worktree"), "baseRef": .string("release"), "branch": .string("scheduled-review"),
        ]),
        "modelSelection": .object([
            "instanceId": .string("provider-custom"), "model": .string("model-custom"),
            "options": .array([.object(["id": .string("reasoning"), "value": .string("high")])]),
        ]),
        "runtimeMode": .string("auto-accept-edits"), "interactionMode": .string("plan"),
        "createdBy": .string("agent"), "creationSource": .string("mcp"),
        "createdAt": .string("2026-10-01T16:00:00.000Z"), "updatedAt": .string("2026-10-04T16:00:00.000Z"),
        "nextRunAt": .string("2026-10-05T16:00:00.000Z"), "lastRunAt": .string("2026-10-04T16:00:00.000Z"),
        "lastRunStatus": .string("failed"), "lastRunError": .string("Provider is offline"), "runCount": .number(4),
    ])

    static func task() throws -> ScheduledTask { try taskJSON.decode(ScheduledTask.self) }
}
