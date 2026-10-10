import Foundation
import XCTest
@testable import T3Code

@MainActor
final class ScheduledTaskClientTests: XCTestCase {
    func testNativeTaskMutationChecksCurrentDestinationPermission() async throws {
        for allowed in [false, true] {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: directory) }
            let store = EnvironmentStore(fileURL: directory.appendingPathComponent("environments.json"))
            try await store.upsert(Self.environment)
            let connection = ScheduledTaskTestConnection()
            let runtime = EnvironmentRuntime(environmentStore: store, credentialStore: Self.credentials(),
                httpTransport: ScheduledTaskTicketTransport(version: 2,
                    permissions: allowed ? ["orchestration:operate"] : []),
                webSocketConnector: ScheduledTaskTestConnector(connection: connection))
            let native = NativeFeatureClient(runtime: runtime)
            do {
                _ = try await native.setScheduledTaskEnabled(.init(environmentID: Self.environment.id,
                    taskID: "task-local"), enabled: false)
                XCTAssertTrue(allowed)
            } catch is EnvironmentPermissionDeniedError {
                XCTAssertFalse(allowed)
            }
            let calls = await connection.requests
            XCTAssertEqual(calls.map(\.method), allowed ? ["scheduledTasks.setEnabled"] : [])
            let client = await runtime.client(for: Self.environment)
            await client.disconnect()
        }
    }

    func testWebhookStreamAndRotationWorkOnBothProtocolsWithFutureRows() async throws {
        for version in [1, 2] {
            let connection = ScheduledTaskTestConnection(
                task: ScheduledWebhookFixtures.row(url: "https://hooks.example/old"),
                extraTasks: [ScheduledTaskTestFixtures.taskJSON,
                    ScheduledWebhookFixtures.row(id: "future", schedule: .object(["type": .string("future")]))])
            let client = T3Client(environment: Self.environment, credentialStore: Self.credentials(),
                httpTransport: ScheduledTaskTicketTransport(version: version),
                webSocketConnector: ScheduledTaskTestConnector(connection: connection))
            let list = try await client.listScheduledTasks()
            XCTAssertEqual(list.tasks.map(\.id), ["webhook", "task-local"])
            var updates = await client.scheduledTaskUpdates().makeAsyncIterator()
            let initial = try await updates.next()
            XCTAssertEqual(initial, list)
            let rotated = try await client.rotateScheduledTaskWebhookToken(id: "webhook")
            XCTAssertEqual(rotated.webhook?.url, "https://hooks.example/new")
            let update = try await updates.next()
            XCTAssertEqual(update?.tasks.first?.webhook?.url, "https://hooks.example/new")
            let calls = await connection.requests
            XCTAssertEqual(calls.last?.method, "scheduledTasks.rotateWebhookToken")
            XCTAssertEqual(calls.last?.payload, .object(["id": .string("webhook")]))
            await client.disconnect()
        }
    }

    func testSharedServicesAndLiveListWorkWithBothOrchestrationVersions() async throws {
        for version in [1, 2] {
            let connection = ScheduledTaskTestConnection()
            let client = T3Client(environment: Self.environment, credentialStore: Self.credentials(),
                httpTransport: ScheduledTaskTicketTransport(version: version),
                webSocketConnector: ScheduledTaskTestConnector(connection: connection))
            let initial = try await client.listScheduledTasks()
            XCTAssertEqual(initial.tasks.count, 1)
            var updates = await client.scheduledTaskUpdates().makeAsyncIterator()
            let first = try await updates.next()
            XCTAssertEqual(first, initial)

            var input = try ScheduledTaskTestFixtures.taskJSON.decode(ScheduledTaskUpsertInput.self)
            input.title = "Updated"
            input.requireExisting = true
            let saved = try await client.upsertScheduledTask(input)
            XCTAssertEqual(saved.title, "Updated")
            let afterSave = try await updates.next()
            XCTAssertEqual(afterSave?.tasks.first?.title, "Updated")

            let paused = try await client.setScheduledTaskEnabled(id: saved.id, enabled: false)
            XCTAssertFalse(paused.enabled)
            let afterPause = try await updates.next()
            XCTAssertEqual(afterPause?.tasks.first?.enabled, false)

            let running = try await client.runScheduledTaskNow(id: saved.id)
            XCTAssertEqual(running.lastRunStatus, .running)
            _ = try await updates.next()
            try await client.deleteScheduledTask(id: saved.id)
            let afterDelete = try await updates.next()
            XCTAssertEqual(afterDelete?.tasks, [])

            let calls = await connection.requests
            XCTAssertEqual(calls.map(\.method), ["scheduledTasks.list", "scheduledTasks.subscribe",
                "scheduledTasks.upsert", "scheduledTasks.setEnabled", "scheduledTasks.runNow", "scheduledTasks.delete"])
            XCTAssertEqual(calls[3].payload, .object(["id": .string("task-local"), "enabled": .bool(false)]))
            XCTAssertEqual(calls[4].payload, .object(["id": .string("task-local")]))
            XCTAssertEqual(calls[5].payload, .object(["id": .string("task-local")]))
            XCTAssertEqual(calls[2].payload["projectId"], .string("project-local"))
            XCTAssertEqual(calls[2].payload["threadId"], .string("thread-local"))
            await client.disconnect()
        }
    }

    func testNativeSubscriptionFallsBackOnlyForUnsupportedSubscription() async throws {
        for (message, fallsBack) in [
            ("Unknown request tag: scheduledTasks.subscribe", true),
            ("Forbidden scheduledTasks.subscribe", false),
        ] {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: directory) }
            let store = EnvironmentStore(fileURL: directory.appendingPathComponent("environments.json"))
            try await store.upsert(Self.environment)
            let connection = ScheduledTaskTestConnection(subscriptionFailure: message)
            let runtime = EnvironmentRuntime(environmentStore: store, credentialStore: Self.credentials(),
                httpTransport: ScheduledTaskTicketTransport(version: 1),
                webSocketConnector: ScheduledTaskTestConnector(connection: connection))
            let native = NativeFeatureClient(runtime: runtime)
            var iterator = native.scheduledTaskUpdates(environmentID: Self.environment.id).makeAsyncIterator()
            do {
                let snapshot = try await iterator.next()
                XCTAssertTrue(fallsBack)
                XCTAssertEqual(snapshot?.tasks.count, 1)
                XCTAssertEqual(snapshot?.receivesLiveUpdates, false)
                let finished = try await iterator.next()
                XCTAssertNil(finished)
            } catch {
                XCTAssertFalse(fallsBack)
                XCTAssertTrue(error.localizedDescription.contains("Forbidden"))
            }
            let calls = await connection.requests
            XCTAssertEqual(calls.map(\.method), fallsBack
                ? ["scheduledTasks.subscribe", "scheduledTasks.list"] : ["scheduledTasks.subscribe"])
            let client = await runtime.client(for: Self.environment)
            await client.disconnect()
        }
    }

    private static var environment: Environment {
        Environment(id: "scheduled-env", label: "Scheduled host", httpBaseURL: URL(string: "https://scheduled.example")!,
                    webSocketBaseURL: URL(string: "wss://scheduled.example")!)
    }

    private static func credentials() -> InMemoryCredentialStore {
        InMemoryCredentialStore(credentials: [environment.id: .init(accessToken: "fixture-token")])
    }
}

private struct ScheduledTaskTicketTransport: HTTPTransport {
    let version: Int
    var permissions: [String] = []
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let value: JSONValue
        if request.url?.path == "/api/auth/session" {
            value = .object(["authenticated": .bool(true), "scopes": .array([.string("orchestration:operate")]),
                             "permissions": .array(permissions.map(JSONValue.string))])
        } else if request.url?.path == "/.well-known/t3/environment" {
            value = .object([
                "environmentId": .string("scheduled-env"), "label": .string("Scheduled host"),
                "platform": .object(["os": .string("darwin"), "arch": .string("arm64")]),
                "serverVersion": .string("fixture"), "capabilities": .object([:]),
                "orchestrationProtocolVersion": .number(Double(version)),
            ])
        } else {
            value = .object(["ticket": .string("fixture-ticket"), "expiresAt": .string("2026-10-04T16:05:00.000Z")])
        }
        return (try JSONEncoder.t3.encode(value), HTTPURLResponse(url: request.url!, statusCode: 200,
            httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!)
    }
}

private struct ScheduledTaskTestConnector: WebSocketConnecting {
    let connection: ScheduledTaskTestConnection
    func connect(to _: URL) async throws -> any WebSocketConnection { connection }
}

private actor ScheduledTaskTestConnection: WebSocketConnection {
    struct Request: Sendable { let method: String; let payload: JSONValue }
    private(set) var requests: [Request] = []
    private let subscriptionFailure: String?
    private var task: JSONValue?
    private let extraTasks: [JSONValue]
    private var subscriptionID: Int?
    private var responses: [Data] = []
    private var receiver: CheckedContinuation<Data, any Error>?

    init(subscriptionFailure: String? = nil, task: JSONValue = ScheduledTaskTestFixtures.taskJSON,
         extraTasks: [JSONValue] = []) {
        self.subscriptionFailure = subscriptionFailure
        self.task = task
        self.extraTasks = extraTasks
    }

    func send(_ data: Data) throws {
        let request = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        guard let method = request["tag"]?.stringValue, case let .number(rawID) = request["id"] else { return }
        let id = Int(rawID)
        let payload = request["payload"] ?? .object([:])
        requests.append(.init(method: method, payload: payload))
        switch method {
        case "scheduledTasks.list": try reply(id: id, value: list)
        case "scheduledTasks.subscribe":
            if let subscriptionFailure {
                try enqueue(.object([
                    "_tag": .string("Exit"), "requestId": .number(Double(id)),
                    "exit": .object(["_tag": .string("Failure"), "cause": .array([.object([
                        "_tag": .string("Die"), "defect": .string(subscriptionFailure),
                    ])])]),
                ]))
            } else {
                subscriptionID = id
                try pushList()
            }
        case "scheduledTasks.upsert", "scheduledTasks.setEnabled", "scheduledTasks.runNow", "scheduledTasks.rotateWebhookToken":
            guard let current = task, case .object(var fields) = current else { throw RPCError.remote("Task not found") }
            if method == "scheduledTasks.rotateWebhookToken" {
                fields["webhook"] = .object(["path": .string("/api/webhooks/new"),
                    "url": .string("https://hooks.example/new"), "hasSecret": .bool(false)])
            } else if method == "scheduledTasks.runNow" {
                fields["lastRunStatus"] = .string("running")
            } else if case let .object(changes) = payload {
                fields.merge(changes) { _, new in new }
            }
            task = .object(fields)
            try reply(id: id, value: .object(["task": .object(fields)]))
            try pushList()
        case "scheduledTasks.delete":
            task = nil
            try reply(id: id, value: payload)
            try pushList()
        default: throw RPCError.remote("Unexpected method \(method)")
        }
    }

    func receive() async throws -> Data {
        if !responses.isEmpty { return responses.removeFirst() }
        return try await withCheckedThrowingContinuation { receiver = $0 }
    }

    func close() { receiver?.resume(throwing: CancellationError()); receiver = nil }

    private var list: JSONValue { .object(["tasks": .array((task.map { [$0] } ?? []) + extraTasks)]) }

    private func pushList() throws {
        guard let subscriptionID else { return }
        try enqueue(.object(["_tag": .string("Chunk"), "requestId": .number(Double(subscriptionID)), "values": .array([list])]))
    }

    private func reply(id: Int, value: JSONValue) throws {
        try enqueue(.object(["_tag": .string("Exit"), "requestId": .number(Double(id)),
                             "exit": .object(["_tag": .string("Success"), "value": value])]))
    }

    private func enqueue(_ value: JSONValue) throws {
        let data = try JSONEncoder.t3.encode(value)
        if let receiver { self.receiver = nil; receiver.resume(returning: data) }
        else { responses.append(data) }
    }
}
