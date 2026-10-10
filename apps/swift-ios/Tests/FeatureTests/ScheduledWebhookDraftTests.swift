import XCTest
@testable import T3Code

@MainActor
final class ScheduledWebhookDraftTests: XCTestCase {
    func testAgeLimitsAndBlankPrompt() throws {
        let project = FeatureProject(id: "project-local", environmentID: "remote", name: "Project", path: "/project")
        var draft = FeatureScheduledTaskDraft(environmentID: "remote", project: project,
            selection: .init(providerID: "provider", modelID: "model"))
        draft.title = "Webhook"
        draft.scheduleMode = .webhook
        XCTAssertEqual(try draft.input(projects: [project]).prompt, "Handle this webhook:\n{{body}}")
        for (text, age) in [("", nil), ("  ", nil), ("1", 1), ("1440", 1440)] as [(String, Int?)] {
            draft.maxDeliveryAgeMinutes = text
            XCTAssertEqual(try draft.schedule(), .webhook(signature: nil, maxDeliveryAgeMinutes: age))
        }
        for text in ["0", "-1", "1.5", "1.0", "1441", "1e2", "NaN", "∞"] {
            draft.maxDeliveryAgeMinutes = text
            XCTAssertThrowsError(try draft.schedule(), "Accepted \(text)")
        }
    }

    func testLatestSubscribedSignatureWinsAndMissingTaskCannotSave() throws {
        let task = try ScheduledWebhookFixtures.row().decode(ScheduledTask.self)
        let current = try ScheduledWebhookFixtures.row(schedule: .object([
            "type": .string("webhook"), "signature": .object([
                "header": .string("x-new-signature"), "encoding": .string("base64"), "prefix": .string("new="),
            ]),
        ])).decode(ScheduledTask.self)
        let project = FeatureProject(id: "project-local", environmentID: "remote", name: "Project", path: "/project")
        let draft = FeatureScheduledTaskDraft(environmentID: "remote", task: task, project: project)
        XCTAssertThrowsError(try draft.input(projects: [project]))
        let input = try draft.input(projects: [project], latestTask: current)
        XCTAssertEqual(input.schedule, current.schedule)
        XCTAssertTrue(input.requireExisting == true)
        XCTAssertNil(try JSONValue.encode(input)["schedule"]?["signature"]?["secret"])
        // A signature disabled by another client must also stay disabled.
        let signedDraft = FeatureScheduledTaskDraft(environmentID: "remote", task: current, project: project)
        XCTAssertEqual(try signedDraft.input(projects: [project], latestTask: task).schedule, task.schedule)
    }

    func testAddressUsesReturnedPublicURLOrOwningEnvironmentOrigin() {
        let endpoint = ScheduledTaskWebhookEndpoint(path: "/api/webhooks/test", url: nil, hasSecret: false)
        let remote = FeatureWebhookAddress(endpoint: endpoint, httpBaseURL: "https://remote.example")
        XCTAssertEqual(remote.address, "https://remote.example/api/webhooks/test")
        XCTAssertTrue(remote.copyable)
        XCTAssertNotNil(remote.note)
        let local = FeatureWebhookAddress(endpoint: endpoint, httpBaseURL: "http://127.0.0.1:3773")
        XCTAssertTrue(local.note?.contains("Only this computer") == true)
        let unknown = FeatureWebhookAddress(endpoint: endpoint, httpBaseURL: nil)
        XCTAssertEqual(unknown.address, endpoint.path)
        XCTAssertFalse(unknown.copyable)
        let publicAddress = FeatureWebhookAddress(endpoint: .init(path: endpoint.path,
            url: "https://hooks.example/token", hasSecret: false), httpBaseURL: "https://remote.example")
        XCTAssertEqual(publicAddress.address, "https://hooks.example/token")
        XCTAssertNil(publicAddress.note)
    }
}
