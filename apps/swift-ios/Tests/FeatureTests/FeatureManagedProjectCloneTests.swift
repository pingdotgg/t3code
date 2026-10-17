import Foundation
import Testing
@testable import T3Code

@MainActor
struct FeatureManagedProjectCloneTests {
    @Test func olderHostsDoNotSubscribeOrBlockStart() async {
        let client = CloneTestClient(supported: false)
        let controller = FeatureProjectCloneController()
        let project = project(environmentID: "old")
        #expect(!controller.state(for: project).blocksStart)
        await controller.observe(environmentID: "old", client: client)
        #expect(client.subscriptionCount == 0)
        #expect(!controller.state(for: project).blocksStart)
    }

    @Test func pendingListOnlyBlocksTheExactNewCloneThenTracksTheServerState() async {
        let controller = FeatureProjectCloneController()
        let project = project(environmentID: "host")
        let identity = FeatureProjectCloneIdentity(environmentID: "host", projectID: "same-wire-id")
        let clone = clone(environmentID: "host", phase: .running)
        let client = CloneTestClient(updates: [[clone]])
        #expect(controller.state(for: project, awaitingClone: identity) == .pending)
        client.onSubscribe = {
            #expect(controller.state(for: project, awaitingClone: identity) == .pending)
            #expect(controller.state(for: project) == .untracked)
            #expect(controller.state(for: self.project(environmentID: "other"), awaitingClone: identity) == .untracked)
            #expect(controller.state(for: self.project(environmentID: "host", wireID: "ordinary"), awaitingClone: identity) == .untracked)
        }
        await controller.observe(environmentID: "host", client: client)
        #expect(controller.state(for: project) == .tracked(clone))
        #expect(controller.state(for: project).blocksStart)
    }

    @Test func failedAndCancelledClonesBlockButCompletedAndRemovedClonesReleaseStart() async {
        let controller = FeatureProjectCloneController()
        let project = project(environmentID: "host")
        for phase in [ProjectClonePhase.failed, .cancelled, .done] {
            let client = CloneTestClient(updates: [[clone(environmentID: "host", phase: phase)]])
            await controller.observe(environmentID: "host", client: client)
            #expect(controller.state(for: project).blocksStart == (phase != .done))
        }
        await controller.observe(environmentID: "host", client: CloneTestClient(updates: [[]]))
        #expect(controller.state(for: project) == .untracked)
    }

    @Test func clonedDatabaseIDsNeverLeakBetweenEnvironments() async {
        let controller = FeatureProjectCloneController()
        let other = clone(environmentID: "other", phase: .running)
        let owned = clone(environmentID: "host", phase: .failed)
        let client = CloneTestClient(updates: [[other, owned]])
        await controller.observe(environmentID: "host", client: client)
        #expect(controller.clones == [owned])
        #expect(controller.state(for: project(environmentID: "host")) == .tracked(owned))
        #expect(controller.state(for: project(environmentID: "other")) == .untracked)
        await controller.perform(.cancel, clone: other, client: client)
        #expect(client.actions.isEmpty)
        await controller.perform(.retry, clone: owned, client: client)
        #expect(client.actions.first?.0 == .retry)
        #expect(client.actions.first?.1.environmentID == "host")
        #expect(client.actions.first?.1.snapshot.projectId == "same-wire-id")
        // Only the stream confirms a phase change, never the action's response.
        #expect(controller.state(for: project(environmentID: "host")) == .tracked(owned))
    }

    @Test func failedOrClosedSubscriptionKeepsOnlyTheKnownClonePending() async {
        let controller = FeatureProjectCloneController()
        let project = project(environmentID: "host")
        let identity = FeatureProjectCloneIdentity(environmentID: "host", projectID: "same-wire-id")
        for client in [
            CloneTestClient(failure: RPCError.disconnected),
            CloneTestClient(failure: CancellationError()),
            CloneTestClient(),
        ] {
            await controller.observe(environmentID: "host", client: client)
            #expect(!controller.state(for: project).blocksStart)
            #expect(controller.state(for: project, awaitingClone: identity) == .pending)
            #expect(controller.errorMessage != nil)
        }
        await controller.observe(environmentID: "host", client: CloneTestClient(updates: [[]]))
        #expect(controller.state(for: project, awaitingClone: identity) == .untracked)
        #expect(controller.errorMessage == nil)
    }

    @Test func staleClientCancellationKeepsLastSnapshotAndAllowsRefresh() async {
        let controller = FeatureProjectCloneController()
        let project = project(environmentID: "host")
        let running = clone(environmentID: "host", phase: .running)
        let client = CloneTestClient(updates: [[running]], failure: CancellationError())
        await controller.observe(environmentID: "host", client: client)
        #expect(!Task.isCancelled)
        #expect(controller.state(for: project) == .tracked(running))
        #expect(controller.state(for: project).blocksStart)
        #expect(controller.errorMessage?.contains("refresh") == true)

        let done = clone(environmentID: "host", phase: .done)
        await controller.observe(environmentID: "host", client: CloneTestClient(updates: [[done]]))
        #expect(controller.state(for: project) == .tracked(done))
        #expect(!controller.state(for: project).blocksStart)
        #expect(controller.errorMessage == nil)
    }

    @Test func cancellingTheObservationTaskDoesNotShowRefreshError() async {
        let controller = FeatureProjectCloneController()
        let (stream, continuation) = AsyncThrowingStream<[FeatureManagedProjectClone], Error>.makeStream()
        defer { continuation.finish() }
        let client = CloneTestClient()
        client.stream = stream
        let (subscribed, subscribedContinuation) = AsyncStream<Void>.makeStream()
        client.onSubscribe = { subscribedContinuation.yield(()); subscribedContinuation.finish() }
        let observation = Task { await controller.observe(environmentID: "host", client: client) }
        for await _ in subscribed {}
        observation.cancel()
        await observation.value
        #expect(controller.errorMessage == nil)
    }

    @Test func reconnectDoesNotReleaseTheNewCloneBeforeTheNextSnapshot() async {
        let controller = FeatureProjectCloneController()
        let project = project(environmentID: "host")
        let identity = FeatureProjectCloneIdentity(environmentID: "host", projectID: "same-wire-id")
        await controller.observe(environmentID: "host", client: CloneTestClient(updates: [[clone(environmentID: "host", phase: .running)]]))
        let reconnect = CloneTestClient(updates: [[clone(environmentID: "host", phase: .done)]])
        reconnect.onSubscribe = {
            #expect(controller.state(for: project, awaitingClone: identity) == .pending)
            #expect(!controller.state(for: project).blocksStart)
        }
        await controller.observe(environmentID: "host", client: reconnect)
        #expect(!controller.state(for: project, awaitingClone: identity).blocksStart)
    }

    @Test func lostStartReplyReconcilesFromCloneOrProjectInItsEnvironment() {
        let pending = pendingClone()
        let tracked = clone(environmentID: "host", phase: .running)
        let fromClone = pending.acceptedResult(clones: [tracked], projects: [])
        #expect(fromClone?.projectId == pending.input.projectId)
        #expect(fromClone?.cwd == tracked.snapshot.destinationPath)
        #expect(fromClone?.remoteUrl == tracked.snapshot.remoteUrl)

        let fromProject = pending.acceptedResult(clones: [], projects: [project(environmentID: "host")])
        #expect(fromProject?.projectId == pending.input.projectId)
        #expect(fromProject?.cwd == "/work/repo")

        var accepted = pending
        accepted.result = fromClone
        #expect(accepted.acceptedResult(clones: [], projects: []) == fromClone)
    }

    @Test func lostStartReplyDoesNotClaimAnotherEnvironmentOrProjectAtTheSamePath() {
        let pending = pendingClone()
        #expect(pending.acceptedResult(clones: [clone(environmentID: "other", phase: .running)],
            projects: [project(environmentID: "other"), project(environmentID: "host", wireID: "unrelated")]) == nil)
        #expect(pending.acceptedResult(clones: [], projects: []) == nil)
    }

    @Test func removingACloneDoesNotRemoveTheLocalStateUntilServerConfirms() async {
        let controller = FeatureProjectCloneController()
        let clone = clone(environmentID: "host", phase: .cancelled)
        let client = CloneTestClient(updates: [[clone]])
        await controller.observe(environmentID: "host", client: client)
        client.actionFailure = RPCError.disconnected
        #expect(await controller.remove(clone, client: client) == false)
        #expect(controller.clones == [clone])
        client.actionFailure = nil
        #expect(await controller.remove(clone, client: client))
        #expect(controller.clones.isEmpty)
        #expect(!controller.state(for: project(environmentID: "host")).blocksStart)
    }

    @Test func changingEnvironmentDiscardsOldStreamFailure() async {
        let controller = FeatureProjectCloneController()
        let (stream, continuation) = AsyncThrowingStream<[FeatureManagedProjectClone], Error>.makeStream()
        let first = CloneTestClient()
        first.stream = stream
        let (subscribed, subscribedContinuation) = AsyncStream<Void>.makeStream()
        first.onSubscribe = { subscribedContinuation.yield(()); subscribedContinuation.finish() }
        let oldObservation = Task { await controller.observe(environmentID: "old", client: first) }
        for await _ in subscribed {}
        await controller.observe(environmentID: "new", client: CloneTestClient(updates: [[]]))
        continuation.finish(throwing: RPCError.disconnected)
        await oldObservation.value
        #expect(controller.environmentID == "new")
        #expect(controller.errorMessage == nil)
        #expect(controller.state(for: project(environmentID: "new")) == .untracked)
    }

    private func pendingClone() -> FeaturePendingManagedProjectClone {
        FeaturePendingManagedProjectClone(environmentID: "host", input: ProjectCloneStartInput(
            projectId: "same-wire-id", title: "Repo", createdAt: "2026-10-04T12:00:00Z",
            remoteUrl: "https://example.test/repo.git", destinationPath: "~/repo"
        ))
    }

    private func project(environmentID: String, wireID: String = "same-wire-id") -> FeatureProject {
        FeatureProject(id: FeatureScopedID.project(environmentID: environmentID, wireID: wireID),
            wireID: wireID, environmentID: environmentID, name: "Repo", path: "/work/repo")
    }

    private func clone(environmentID: String, phase: ProjectClonePhase) -> FeatureManagedProjectClone {
        FeatureManagedProjectClone(environmentID: environmentID, snapshot: ProjectCloneSnapshot(
            projectId: "same-wire-id", remoteUrl: "https://example.test/repo.git", destinationPath: "/work/repo",
            repository: nil, phase: phase, stage: .receiving, percent: 45, detail: nil, error: nil,
            startedAt: "2026-10-04T12:00:00Z", endedAt: nil, sequence: 1
        ))
    }
}

@MainActor
private final class CloneTestClient: FeatureManagedProjectCloning {
    let supported: Bool
    let updates: [[FeatureManagedProjectClone]]
    let failure: (any Error)?
    var actionFailure: (any Error)?
    var onSubscribe: (() -> Void)?
    var subscriptionCount = 0
    var actions: [(ProjectCloneAction, FeatureManagedProjectClone)] = []
    var stream: AsyncThrowingStream<[FeatureManagedProjectClone], Error>?

    init(supported: Bool = true, updates: [[FeatureManagedProjectClone]] = [], failure: (any Error)? = nil) {
        self.supported = supported
        self.updates = updates
        self.failure = failure
    }

    func supportsManagedProjectClones(environmentID: String) async throws -> Bool { supported }
    func startManagedProjectClone(environmentID: String, input: ProjectCloneStartInput) async throws -> ProjectCloneStartResult {
        ProjectCloneStartResult(projectId: input.projectId, cwd: input.destinationPath, remoteUrl: input.remoteUrl, repository: nil)
    }
    func managedProjectCloneUpdates(environmentID: String) -> AsyncThrowingStream<[FeatureManagedProjectClone], Error> {
        subscriptionCount += 1
        onSubscribe?()
        return stream ?? AsyncThrowingStream { continuation in
            for value in updates { continuation.yield(value) }
            continuation.finish(throwing: failure)
        }
    }
    func performManagedProjectCloneAction(_ action: ProjectCloneAction, clone: FeatureManagedProjectClone) async throws -> Bool {
        actions.append((action, clone))
        if let actionFailure { throw actionFailure }
        return true
    }
    func removeManagedCloneProject(_ clone: FeatureManagedProjectClone) async throws {
        if let actionFailure { throw actionFailure }
    }
}
