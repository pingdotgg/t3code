import Foundation
import Testing
@testable import T3Code

@Suite("Durable mobile outbox")
struct FeatureOutboxStoreTests {
    @Test
    func roundTripPreservesStableWireIdentityAndAttachments() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-feature-outbox-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FeatureOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        let identity = FeatureSubmissionIdentity(
            threadID: "thread-wire",
            commandID: "command-wire",
            messageID: "message-wire",
            createdAt: Date(timeIntervalSince1970: 42)
        )
        let submission = FeatureQueuedSubmission(
            environmentID: "environment-1",
            identity: identity,
            threadID: "thread-scoped",
            text: "Ship it",
            selection: .init(providerID: "codex", modelID: "gpt-5.6-sol"),
            runtimeMode: .automatic,
            interactionMode: .plan,
            attachments: [
                .init(data: Data([0x01, 0x02]), name: "reference.png", mimeType: "image/png"),
            ]
        )

        try await store.enqueue(submission)
        let restored = try await FeatureOutboxStore(
            fileURL: store.fileURL
        ).submissions()

        #expect(restored.count == 1)
        #expect(restored[0].identity == identity)
        #expect(restored[0].runtimeMode == .fullAccess)
        #expect(restored[0].interactionMode == .standard)
        #expect(restored[0].attachments.first?.data == Data([0x01, 0x02]))
    }

    @Test
    func policySendsFollowUpsWhileWorkingAndWaitsWhenOffline() {
        let thread = FeatureThread(
            id: "thread-scoped",
            projectID: "project-1",
            environmentID: "environment-1",
            title: "Working",
            state: .working
        )
        let submission = FeatureQueuedSubmission(
            environmentID: "environment-1",
            identity: FeatureSubmissionIdentity(),
            threadID: thread.id,
            text: "Queue this next",
            selection: .init(providerID: "codex", modelID: "gpt-5.6-sol"),
            runtimeMode: .fullAccess,
            interactionMode: .standard,
            attachments: []
        )
        let environment = FeatureEnvironment(
            id: "environment-1",
            name: "Studio",
            endpoint: "https://studio.example",
            isActive: true,
            connectionState: .connected
        )
        let connected = FeatureSnapshot(
            connection: .init(state: .connected),
            environments: [environment],
            threads: [thread]
        )
        var offline = connected
        offline.connection.state = .disconnected
        offline.environments[0].connectionState = .disconnected

        #expect(FeatureOutboxPolicy.decision(for: submission, snapshot: connected) == .send)
        #expect(FeatureOutboxPolicy.decision(for: submission, snapshot: offline) == .wait)
    }

    @Test
    func committedCreationAndDeletedThreadAreDiscarded() {
        let thread = FeatureThread(
            id: "thread-scoped",
            projectID: "project-1",
            environmentID: "environment-1",
            title: "Created"
        )
        let creation = FeatureQueuedSubmission(
            environmentID: "environment-1",
            identity: FeatureSubmissionIdentity(),
            threadID: thread.id,
            text: "Create it",
            selection: .init(providerID: "claude", modelID: "claude-opus-5"),
            runtimeMode: .fullAccess,
            interactionMode: .standard,
            attachments: [],
            creation: .init(
                projectID: "project-1",
                projectName: "Native",
                workspaceMode: .local,
                branch: nil,
                worktreePath: nil,
                startFromOrigin: false
            )
        )
        var snapshot = FeatureSnapshot(
            connection: .init(state: .connected),
            environments: [
                .init(
                    id: "environment-1",
                    name: "Studio",
                    endpoint: "https://studio.example",
                    isActive: true,
                    connectionState: .connected
                ),
            ],
            projects: [
                .init(
                    id: "project-1",
                    environmentID: "environment-1",
                    name: "Native",
                    path: "/native"
                ),
            ],
            threads: [thread]
        )

        #expect(FeatureOutboxPolicy.decision(for: creation, snapshot: snapshot) == .discard)

        var followUp = creation
        followUp.creation = nil
        snapshot.threads = []
        #expect(FeatureOutboxPolicy.decision(for: followUp, snapshot: snapshot) == .discard)
        #expect(
            FeatureOutboxPolicy.decision(
                for: followUp,
                snapshot: snapshot,
                pendingCreationThreadIDs: [creation.threadID]
            ) == .wait
        )
    }
}
