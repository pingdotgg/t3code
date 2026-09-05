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
        let persistedURL = await store.fileURL
        let restored = try await FeatureOutboxStore(
            fileURL: persistedURL
        ).submissions()

        #expect(restored.count == 1)
        #expect(restored[0].identity == identity)
        #expect(restored[0].runtimeMode == .automatic)
        #expect(restored[0].interactionMode == .standard)
        #expect(restored[0].attachments.first?.data == Data([0x01, 0x02]))
    }

    @Test
    func fileBackedRoundTripPreservesLocalAndUploadedIdentity() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-feature-outbox-file-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let sourceURL = directory.appendingPathComponent("provider.json")
        try Data("{}".utf8).write(to: sourceURL)
        let attachmentID = UUID()
        let storageRoot = directory.appendingPathComponent("attachments", isDirectory: true)
        let ownedFile = try ManagedAttachmentFileStore(rootURL: storageRoot).copyOwnedFile(
            from: sourceURL,
            attachmentID: attachmentID,
            originalFileName: "context.json"
        )
        let uploadedReference = FeatureUploadedAttachmentReference(
            environmentID: "environment-1",
            attachmentID: "uploaded-1"
        )
        let store = FeatureOutboxStore(
            fileURL: directory.appendingPathComponent("outbox.json"),
            attachmentStorageRootURL: storageRoot
        )
        let submission = FeatureQueuedSubmission(
            environmentID: "environment-1",
            identity: FeatureSubmissionIdentity(),
            threadID: "thread-1",
            text: "Review",
            selection: nil,
            runtimeMode: .fullAccess,
            interactionMode: .standard,
            attachments: [
                FeatureUploadAttachment(
                    id: attachmentID,
                    ownedFile: ownedFile,
                    name: "context.json",
                    mimeType: "application/json",
                    uploadedReference: uploadedReference
                ),
            ]
        )

        try await store.enqueue(submission)
        let persistedURL = await store.fileURL
        let restored = try await FeatureOutboxStore(
            fileURL: persistedURL,
            attachmentStorageRootURL: storageRoot
        ).submissions().first

        #expect(restored?.uploads.first?.id == attachmentID)
        #expect(restored?.uploads.first?.ownedFile?.url == ownedFile.url)
        #expect(restored?.uploads.first?.byteCount == 2)
        #expect(restored?.uploads.first?.uploadedReference == uploadedReference)
        let json = try #require(String(data: Data(contentsOf: persistedURL), encoding: .utf8))
        #expect(!json.contains(Data("{}".utf8).base64EncodedString()))
    }

    @Test
    func restoreAcceptsImageAttachmentWithoutNewFileFields() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-feature-outbox-old-image-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let fileURL = directory.appendingPathComponent("outbox.json")
        let identity = FeatureSubmissionIdentity(
            threadID: "thread-1",
            commandID: "command-1",
            messageID: "message-1",
            createdAt: Date(timeIntervalSince1970: 42)
        )
        let submission = FeatureQueuedSubmission(
            environmentID: "environment-1",
            identity: identity,
            threadID: "thread-1",
            text: "Old image",
            selection: nil,
            runtimeMode: .fullAccess,
            interactionMode: .standard,
            attachments: [
                FeatureUploadAttachment(
                    data: Data([1, 2, 3]),
                    name: "old.png",
                    mimeType: "image/png"
                ),
            ]
        )
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let current = try JSONSerialization.jsonObject(
            with: JSONEncoder.t3.encode(submission)
        ) as! [String: Any]
        var legacy = current
        var attachments = legacy["attachments"] as! [[String: Any]]
        attachments[0].removeValue(forKey: "id")
        attachments[0].removeValue(forKey: "byteCount")
        legacy["attachments"] = attachments
        try JSONSerialization.data(
            withJSONObject: ["version": 1, "submissions": [legacy]]
        ).write(to: fileURL)

        let restored = try await FeatureOutboxStore(fileURL: fileURL).submissions().first

        #expect(restored?.uploads.first?.data == Data([1, 2, 3]))
        #expect(restored?.uploads.first?.ownedFile == nil)
    }

    @Test
    func restorePreservesLegacyPermission() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-feature-outbox-legacy-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FeatureOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        var submission = FeatureQueuedSubmission(
            environmentID: "environment-1",
            identity: FeatureSubmissionIdentity(),
            threadID: "thread-scoped",
            text: "Retry this",
            selection: nil,
            runtimeMode: .automatic,
            interactionMode: .standard,
            attachments: []
        )
        submission.runtimeMode = .autoAcceptEdits
        try await store.enqueue(submission)
        let persistedURL = await store.fileURL

        let restored = try await FeatureOutboxStore(fileURL: persistedURL).submissions()

        #expect(restored.first?.runtimeMode == .autoAcceptEdits)
    }

    @Test
    func failedLoadPreservesSavedMessagesAndRetriesBeforeWriting() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-feature-outbox-retry-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let fileURL = directory.appendingPathComponent("outbox.json")
        let saved = FeatureQueuedSubmission(
            environmentID: "saved-environment",
            identity: FeatureSubmissionIdentity(createdAt: Date(timeIntervalSince1970: 1)),
            threadID: "saved-thread",
            text: "Keep this message",
            selection: nil,
            runtimeMode: .fullAccess,
            interactionMode: .standard,
            attachments: [
                FeatureUploadAttachment(
                    data: Data([1, 2, 3]),
                    name: "reference.png",
                    mimeType: "image/png"
                ),
            ]
        )
        let incoming = FeatureQueuedSubmission(
            environmentID: "another-environment",
            identity: FeatureSubmissionIdentity(createdAt: Date(timeIntervalSince1970: 2)),
            threadID: "another-thread",
            text: "Send after recovery",
            selection: nil,
            runtimeMode: .fullAccess,
            interactionMode: .standard,
            attachments: []
        )
        try await FeatureOutboxStore(fileURL: fileURL).enqueue(saved)
        let savedData = try Data(contentsOf: fileURL)
        let unreadableData = Data("{".utf8)
        try unreadableData.write(to: fileURL, options: .atomic)
        let store = FeatureOutboxStore(fileURL: fileURL)

        await #expect(throws: DecodingError.self) {
            try await store.submissions()
        }
        await #expect(throws: DecodingError.self) {
            try await store.enqueue(incoming)
        }
        await #expect(throws: DecodingError.self) {
            try await store.remove(id: saved.id)
        }
        await #expect(throws: DecodingError.self) {
            try await store.removeAll(environmentID: incoming.environmentID)
        }
        #expect(try Data(contentsOf: fileURL) == unreadableData)

        try savedData.write(to: fileURL, options: .atomic)
        try await store.enqueue(incoming)
        let restored = try await FeatureOutboxStore(fileURL: fileURL).submissions()
        #expect(restored == [saved, incoming])
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
    func existingThreadDoesNotProveItsFirstMessageWasDelivered() {
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

        #expect(FeatureOutboxPolicy.decision(for: creation, snapshot: snapshot) == .send)

        snapshot.environments[0].connectionState = .disconnected
        #expect(FeatureOutboxPolicy.decision(for: creation, snapshot: snapshot) == .wait)
        snapshot.environments[0].connectionState = .connected

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
