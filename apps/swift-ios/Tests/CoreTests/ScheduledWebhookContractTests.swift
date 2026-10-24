import XCTest
@testable import T3Code

final class ScheduledWebhookContractTests: XCTestCase {
    func testMixedListKeepsSupportedRowsAndSkipsFutureSchedule() throws {
        let interval = ScheduledTaskTestFixtures.taskJSON
        let fixed = ScheduledWebhookFixtures.row(id: "fixed", schedule: .object([
            "type": .string("fixed_time"), "timeOfDay": .string("09:00"),
        ]))
        let unknown = ScheduledWebhookFixtures.row(id: "future", schedule: .object(["type": .string("future")]))
        let list = try JSONValue.object(["tasks": .array([
            interval, unknown, ScheduledWebhookFixtures.row(), fixed,
        ])]).decode(ScheduledTaskListResult.self)
        XCTAssertEqual(list.tasks.map(\.id), ["task-local", "webhook", "fixed"])
        XCTAssertEqual(list.tasks[1].schedule, .webhook(signature: nil, maxDeliveryAgeMinutes: nil))
        XCTAssertNil(list.tasks[1].webhook)
    }

    func testPublicSignatureRoundTripDoesNotSendSecretAndEmptyAgeClearsLimit() throws {
        let schedule: ScheduledTaskSchedule = .webhook(signature: .init(
            header: "x-hub-signature-256", encoding: "hex", prefix: "sha256="
        ), maxDeliveryAgeMinutes: nil)
        let json = try JSONValue.encode(schedule)
        XCTAssertEqual(json["signature"]?["header"], .string("x-hub-signature-256"))
        XCTAssertNil(json["signature"]?["secret"])
        XCTAssertNil(json["signature"]?["secretRef"])
        XCTAssertEqual(json["maxDeliveryAgeMinutes"], .null)
        XCTAssertEqual(try json.decode(ScheduledTaskSchedule.self), schedule)
    }

    func testOptionalAgeAndEndpointDecode() throws {
        for age in [JSONValue.null, .number(1), .number(1440)] {
            let task = try ScheduledWebhookFixtures.row(schedule: .object([
                "type": .string("webhook"), "signature": .null, "maxDeliveryAgeMinutes": age,
            ]), url: "https://hooks.example/current").decode(ScheduledTask.self)
            XCTAssertEqual(task.webhook?.url, "https://hooks.example/current")
        }
    }
}

enum ScheduledWebhookFixtures {
    static func row(id: String = "webhook", schedule: JSONValue = .object([
        "type": .string("webhook"), "signature": .null,
    ]), url: String? = nil) -> JSONValue {
        guard case .object(var fields) = ScheduledTaskTestFixtures.taskJSON else { preconditionFailure() }
        fields["id"] = .string(id)
        fields["schedule"] = schedule
        if let url {
            fields["webhook"] = .object(["path": .string("/api/webhooks/current"), "url": .string(url), "hasSecret": .bool(false)])
        }
        return .object(fields)
    }
}
