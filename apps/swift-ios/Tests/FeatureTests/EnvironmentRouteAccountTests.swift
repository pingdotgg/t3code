import Foundation
import Testing
@testable import T3Code

@Suite("Route account cleanup")
@MainActor
struct EnvironmentRouteAccountTests {
    @Test(arguments: [false, true])
    func accountChangeAndSignOutRetainPairedRoutesDraftsAndOutbox(signOut: Bool) async throws {
        let directory = routeTestDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = EnvironmentStore(fileURL: directory.appendingPathComponent("environments.json"))
        var paired = routeFixture()
        paired.isEnabled = false
        let relay = EnvironmentRoute(id: "relay", httpBaseURL: URL(string: "https://relay.example/")!,
                                     webSocketBaseURL: URL(string: "wss://relay.example/ws")!,
                                     kind: .managedDPoP, credentialOwnerID: "cloud")
        try await store.upsert(paired.mergingRoute(relay, select: true))
        let credentials = InMemoryCredentialStore(credentials: [
            paired.credentialID: .init(accessToken: "paired"), "cloud": .init(accessToken: "managed"),
        ])
        let client = NativeFeatureClient(runtime: EnvironmentRuntime(environmentStore: store, credentialStore: credentials))
        let drafts = FeatureComposerDraftStore(fileURL: directory.appendingPathComponent("drafts.json"))
        let outbox = FeatureOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        let thread = FeatureThread(id: "thread", projectID: "project", environmentID: paired.id, title: "Saved")
        let draftKey = FeatureComposerDraftStore.threadKey(thread)
        try await drafts.setDraft(.init(text: "Keep this draft"), for: draftKey)
        try await outbox.enqueue(FeatureQueuedSubmission(
            environmentID: paired.id, identity: FeatureSubmissionIdentity(), threadID: "thread",
            text: "Keep queued work", selection: nil, runtimeMode: .fullAccess,
            interactionMode: .standard, attachments: []
        ))
        let model = FeatureRootModel(client: client, outboxStore: outbox, draftStore: drafts)
        await model.reload()
        #expect(try await client.managedOnlyEnvironmentIDs().isEmpty)
        if signOut { await model.signOutT3Connect() }
        else { await model.removeManagedEnvironmentsAfterAccountChange() }
        #expect(try await store.load() == [paired])
        #expect(try await credentials.credential(for: paired.credentialID)?.accessToken == "paired")
        #expect(try await credentials.credential(for: "cloud") == nil)
        #expect(try await drafts.draft(for: draftKey)?.text == "Keep this draft")
        #expect(try await outbox.submissions().count == 1)
        #expect(model.snapshot.environments.map(\.id) == [paired.id])
        await model.disconnect()
    }

    @Test
    func accountChangeClearsRemovedLogicalDraftAfterSnapshotReplacement() async throws {
        let directory = routeTestDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let drafts = FeatureComposerDraftStore(fileURL: directory.appendingPathComponent("drafts.json"))
        let outbox = FeatureOutboxStore(fileURL: directory.appendingPathComponent("outbox.json"))
        let sharedIdentity = FeatureRepositoryIdentity(canonicalKey: "github.com/t3/shared")
        let removedProject = FeatureProject(
            id: "removed-project", environmentID: "removed", name: "Removed", path: "/removed",
            repositoryIdentity: .init(canonicalKey: "github.com/t3/removed")
        )
        let retainedProject = FeatureProject(
            id: "retained-project", environmentID: "mixed", name: "Shared", path: "/shared",
            repositoryIdentity: sharedIdentity
        )
        let client = AccountChangeFeatureClient(snapshot: FeatureSnapshot(
            environments: [
                .init(id: "removed", name: "Managed only", endpoint: "https://removed.example", source: .t3Connect),
                .init(id: "mixed", name: "Paired and managed", endpoint: "https://mixed.example", source: .t3Connect),
            ],
            projects: [
                removedProject,
                .init(id: "removed-shared", environmentID: "removed", name: "Shared", path: "/shared",
                      repositoryIdentity: sharedIdentity),
                retainedProject,
            ]
        ))
        let removedKey = FeatureComposerDraftStore.newTaskKey(project: removedProject, in: client.snapshot)
        let sharedKey = FeatureComposerDraftStore.newTaskKey(project: retainedProject, in: client.snapshot)
        let removedThreadKey = "environment:removed:thread:thread"
        let retainedThreadKey = "environment:mixed:thread:thread"
        for key in [removedKey, sharedKey, removedThreadKey, retainedThreadKey] {
            try await drafts.setDraft(.init(text: key), for: key)
        }
        for id in ["removed", "mixed"] {
            try await outbox.enqueue(FeatureQueuedSubmission(
                environmentID: id, identity: FeatureSubmissionIdentity(), threadID: "thread",
                text: "Queued", selection: nil, runtimeMode: .fullAccess,
                interactionMode: .standard, attachments: []
            ))
        }
        let model = FeatureRootModel(client: client, outboxStore: outbox, draftStore: drafts)
        await model.reload()
        defer { client.beforeRemovalReturns = nil }
        client.beforeRemovalReturns = {
            // Replace the model snapshot while its route-removal await is still in flight.
            await model.reload()
            #expect(model.snapshot.projects.map(\.id) == [retainedProject.id])
            let preservedDraft = try await drafts.draft(for: removedKey)
            #expect(preservedDraft != nil)
        }

        await model.removeManagedEnvironmentsAfterAccountChange()

        #expect(model.errorMessage == nil)
        #expect(try await drafts.draft(for: removedKey) == nil)
        #expect(try await drafts.draft(for: removedThreadKey) == nil)
        #expect(try await drafts.draft(for: sharedKey)?.text == sharedKey)
        #expect(try await drafts.draft(for: retainedThreadKey)?.text == retainedThreadKey)
        #expect(try await outbox.submissions().map(\.environmentID) == ["mixed"])
        #expect(client.removedEnvironmentIDs.isEmpty)
        await model.disconnect()
    }
}

@MainActor
private final class AccountChangeFeatureClient: FeatureClient, FeatureEnvironmentRoutesManaging {
    var snapshot: FeatureSnapshot
    var beforeRemovalReturns: (() async throws -> Void)?
    private(set) var removedEnvironmentIDs: [String] = []

    init(snapshot: FeatureSnapshot) { self.snapshot = snapshot }

    func initialSnapshot() async throws -> FeatureSnapshot { snapshot }
    func managedOnlyEnvironmentIDs() async throws -> [String] { ["removed"] }
    func removeManagedEnvironmentRoutes() async throws {
        snapshot.environments.removeAll { $0.id == "removed" }
        snapshot.projects.removeAll { $0.environmentID == "removed" }
        try await beforeRemovalReturns?()
    }
    func removeEnvironment(id: String) async throws { removedEnvironmentIDs.append(id) }
    func environmentRoutes(environmentID: String) async throws -> FeatureEnvironmentRoutes {
        throw FeatureCapabilityUnavailable("Routes")
    }
    func addEnvironmentRoute(environmentID: String, pairingURL: String) async throws {}
    func reorderEnvironmentRoutes(environmentID: String, routeIDs: [String]) async throws {}
    func removeEnvironmentRoute(environmentID: String, routeID: String) async throws {}
    func loadThread(id: String, fresh: Bool) async throws -> FeatureThreadDetail {
        throw FeatureCapabilityUnavailable("Threads")
    }
    func createThread(projectID: String, title: String?, selection: FeatureSelection?) async throws -> FeatureThread {
        throw FeatureCapabilityUnavailable("Threads")
    }
    func createThreadAndSend(
        projectID: String, prompt: String, selection: FeatureSelection?, runtimeMode: FeatureRuntimeMode,
        interactionMode: FeatureInteractionMode, workspaceMode: FeatureWorkspaceMode,
        branch: String?, worktreePath: String?, startFromOrigin: Bool,
        attachments: [FeatureUploadAttachment], identity: FeatureSubmissionIdentity,
        context: OrchestrationMessageContext?
    ) async throws -> FeatureThread { throw FeatureCapabilityUnavailable("Messages") }
    func sendMessage(
        threadID: String, text: String, selection: FeatureSelection?, runtimeMode: FeatureRuntimeMode,
        attachments: [FeatureUploadAttachment], identity: FeatureSubmissionIdentity,
        context: OrchestrationMessageContext?
    ) async throws { throw FeatureCapabilityUnavailable("Messages") }
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
