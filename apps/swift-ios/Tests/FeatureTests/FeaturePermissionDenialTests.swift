import Foundation
import Testing
@testable import T3Code

@MainActor
@Suite("Permission denial submission handling")
struct FeaturePermissionDenialTests {
    @Test(arguments: [
        FeatureConnection.State.connected, .connecting, .disconnected, .reconnecting, .needsPairing,
    ], [false, true])
    func permissionDenialIsPermanentRegardlessOfConnection(
        state: FeatureConnection.State, enabled: Bool
    ) {
        let snapshot = FeatureSnapshot(environments: [
            .init(id: "environment", name: "Computer", endpoint: "https://computer.example",
                  isActive: true, isEnabled: enabled, connectionState: state),
        ])
        let denial = EnvironmentPermissionDeniedError(
            message: "Network access requires a new permission grant.",
            requiredScope: "orchestration:operate", requiredPermission: "orchestration:operate",
            traceID: "permission-denied"
        )

        #expect(!FeatureRootModel.shouldQueue(denial, environmentID: "environment", snapshot: snapshot))
        #expect(!FeatureRootModel.shouldQueue(denial, environmentID: "removed", snapshot: snapshot))
    }

    @Test(arguments: [false, true])
    func rejectedSubmissionDoesNotSurviveRestart(creation: Bool) async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("t3-permission-denial-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FeatureOutboxStore(
            fileURL: directory.appendingPathComponent("outbox.json"),
            attachmentStorageRootURL: directory.appendingPathComponent("attachments")
        )
        let drafts = FeatureComposerDraftStore(
            fileURL: directory.appendingPathComponent("drafts.json"),
            attachmentStorageRootURL: directory.appendingPathComponent("attachments")
        )
        let client = PermissionDeniedFeatureClient()
        let model = FeatureRootModel(client: client, outboxStore: store, draftStore: drafts)
        await model.reload()
        _ = await model.detail(for: client.thread.id)

        if creation {
            let created = await model.startTask(NewTaskRequest(
                projectID: "project", prompt: "Create a task", selection: nil,
                runtimeMode: .fullAccess, interactionMode: .standard
            ))
            #expect(created == nil)
            #expect(model.lastTaskStartError == client.denial.localizedDescription)
            #expect(model.snapshot.threads.map(\.id) == [client.thread.id])
        } else {
            let sent = await model.sendMessage(.init(
                threadID: client.thread.id, text: "Send a message", selection: nil
            ))
            #expect(!sent)
            #expect(model.errorMessage == client.denial.localizedDescription)
            #expect(model.details[client.thread.id]?.messages.isEmpty == true)
        }
        #expect(try await store.submissions().isEmpty)
        #expect(client.submissionAttempts == 1)
        await model.disconnect()

        client.connectionState = .connected
        let restored = FeatureRootModel(client: client, outboxStore: store, draftStore: drafts)
        await restored.start()
        #expect(try await store.submissions().isEmpty)
        #expect(client.submissionAttempts == 1)
        await restored.disconnect()
    }
}

@MainActor
private final class PermissionDeniedFeatureClient: FeatureClient {
    let thread = FeatureThread(id: "thread", projectID: "project", environmentID: "environment", title: "Thread")
    let denial = EnvironmentPermissionDeniedError(requiredScope: "orchestration:operate")
    var connectionState: FeatureConnection.State = .disconnected
    private(set) var submissionAttempts = 0

    func initialSnapshot() async throws -> FeatureSnapshot {
        FeatureSnapshot(
            connection: .init(state: connectionState),
            environments: [.init(id: "environment", name: "Computer", endpoint: "https://computer.example",
                                 isActive: true, connectionState: connectionState)],
            projects: [.init(id: "project", environmentID: "environment", name: "Project", path: "/project")],
            threads: [thread]
        )
    }

    func loadThread(id: String, fresh: Bool) async throws -> FeatureThreadDetail {
        FeatureThreadDetail(thread: thread)
    }

    func sendMessage(
        threadID: String, text: String, selection: FeatureSelection?, runtimeMode: FeatureRuntimeMode,
        attachments: [FeatureUploadAttachment], identity: FeatureSubmissionIdentity,
        context: OrchestrationMessageContext?
    ) async throws {
        submissionAttempts += 1
        throw denial
    }

    func createThreadAndSend(
        projectID: String, prompt: String, selection: FeatureSelection?, runtimeMode: FeatureRuntimeMode,
        interactionMode: FeatureInteractionMode, workspaceMode: FeatureWorkspaceMode,
        branch: String?, worktreePath: String?, startFromOrigin: Bool,
        attachments: [FeatureUploadAttachment], identity: FeatureSubmissionIdentity,
        context: OrchestrationMessageContext?
    ) async throws -> FeatureThread {
        submissionAttempts += 1
        throw denial
    }

    func createThread(projectID: String, title: String?, selection: FeatureSelection?) async throws -> FeatureThread {
        throw denial
    }
    func pair(endpoint: String, token: String?) async throws {}
    func renameThread(id: String, title: String) async throws {}
    func setThreadArchived(id: String, archived: Bool) async throws {}
    func deleteThread(id: String) async throws {}
    func cancelTurn(threadID: String) async throws {}
    func resolveApproval(id: String, decision: FeatureApprovalDecision) async throws {}
    func resolveUserInput(
        id: String, answers: [String: FeatureInputAnswer],
        attachmentsByQuestionID: [String: [FeatureUploadAttachment]]
    ) async throws {}
    func saveSettings(_ settings: FeatureSettings) async throws {}
}
