import Foundation
import Testing
@testable import T3Code

@Suite("Durable follow-up delivery")
struct FeatureMessageDeliveryTests {
    @Test(arguments: FeatureMessageDelivery.allCases)
    func relaunchPreservesDeliveryAndIdentity(_ delivery: FeatureMessageDelivery) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let fileURL = directory.appendingPathComponent("outbox.json")
        let submission = FeatureQueuedSubmission(
            environmentID: "environment", identity: .init(threadID: "wire-thread"),
            threadID: "scoped-thread", text: "Follow up", selection: nil,
            runtimeMode: .automatic, interactionMode: .standard, attachments: [], delivery: delivery
        )
        try await FeatureOutboxStore(fileURL: fileURL).enqueue(submission)

        let restored = try #require(await FeatureOutboxStore(fileURL: fileURL).submissions().first)

        #expect(restored == submission)
        #expect(restored.delivery == delivery)
        #expect(restored.identity == submission.identity)
    }

    @Test
    func oldOutboxWithoutDeliveryDefaultsToAuto() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let fileURL = directory.appendingPathComponent("outbox.json")
        let submission = FeatureQueuedSubmission(
            environmentID: "environment", identity: .init(threadID: "wire-thread"),
            threadID: "scoped-thread", text: "Old pending turn", selection: nil,
            runtimeMode: .automatic, interactionMode: .standard, attachments: []
        )
        guard case var .object(fields) = try JSONValue.encode(submission) else {
            Issue.record("Expected an encoded submission")
            return
        }
        fields.removeValue(forKey: "delivery")
        let document = JSONValue.object([
            "version": .number(1), "submissions": .array([.object(fields)]),
        ])
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try JSONEncoder.t3.encode(document).write(to: fileURL)

        let restored = try #require(await FeatureOutboxStore(fileURL: fileURL).submissions().first)

        #expect(restored.delivery == .auto)
        #expect(restored.identity == submission.identity)
        #expect(restored.text == submission.text)
    }
}
