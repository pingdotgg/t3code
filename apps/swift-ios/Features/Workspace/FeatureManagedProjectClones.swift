import Foundation
import Observation

/// A clone's wire ID is only unique inside its owning environment.
struct FeatureManagedProjectClone: Identifiable, Equatable, Sendable {
    let environmentID: String
    let snapshot: ProjectCloneSnapshot

    var id: String { FeatureScopedID.project(environmentID: environmentID, wireID: snapshot.projectId) }
}

/// Carries the exact project opened by Add Project while its first clone list is pending.
public struct FeatureProjectCloneIdentity: Equatable, Sendable {
    let environmentID: String
    let projectID: String

    func matches(_ project: FeatureProject) -> Bool {
        environmentID == project.environmentID && projectID == (project.wireID ?? project.id)
    }
}

struct FeaturePendingManagedProjectClone {
    let environmentID: String
    let input: ProjectCloneStartInput
    var result: ProjectCloneStartResult?

    /// A start reply can be lost after the server has created the project.
    func acceptedResult(clones: [FeatureManagedProjectClone], projects: [FeatureProject]) -> ProjectCloneStartResult? {
        if let result { return result }
        if let clone = clones.first(where: {
            $0.environmentID == environmentID && $0.snapshot.projectId == input.projectId
        }) {
            return ProjectCloneStartResult(projectId: input.projectId, cwd: clone.snapshot.destinationPath,
                remoteUrl: clone.snapshot.remoteUrl, repository: clone.snapshot.repository)
        }
        let identity = FeatureProjectCloneIdentity(environmentID: environmentID, projectID: input.projectId)
        guard let project = projects.first(where: identity.matches) else { return nil }
        return ProjectCloneStartResult(projectId: input.projectId, cwd: project.path,
            remoteUrl: input.remoteUrl, repository: nil)
    }
}

@MainActor
protocol FeatureManagedProjectCloning: AnyObject {
    func supportsManagedProjectClones(environmentID: String) async throws -> Bool
    func startManagedProjectClone(environmentID: String, input: ProjectCloneStartInput) async throws -> ProjectCloneStartResult
    func managedProjectCloneUpdates(environmentID: String) -> AsyncThrowingStream<[FeatureManagedProjectClone], Error>
    func performManagedProjectCloneAction(_ action: ProjectCloneAction, clone: FeatureManagedProjectClone) async throws -> Bool
    func removeManagedCloneProject(_ clone: FeatureManagedProjectClone) async throws
}

enum FeatureProjectCloneState: Equatable {
    case pending
    case untracked
    case tracked(FeatureManagedProjectClone)

    var blocksStart: Bool {
        switch self {
        case .pending: true
        case .untracked: false
        case let .tracked(clone): clone.snapshot.phase != .done
        }
    }
}

/// Own in a draft or project list and call `observe` from an environment-keyed task.
/// Only the project opened from a managed clone waits for the first list.
@MainActor @Observable
final class FeatureProjectCloneController {
    private(set) var environmentID: String?
    private(set) var clones: [FeatureManagedProjectClone] = []
    private(set) var isPending = true
    private(set) var errorMessage: String?
    private(set) var pendingActionID: String?
    private var observationID = UUID()

    func state(for project: FeatureProject, awaitingClone: FeatureProjectCloneIdentity? = nil) -> FeatureProjectCloneState {
        guard environmentID == project.environmentID, !isPending else {
            return awaitingClone?.matches(project) == true ? .pending : .untracked
        }
        guard let clone = clones.first(where: {
            $0.environmentID == project.environmentID
                && ($0.id == project.id || $0.snapshot.projectId == (project.wireID ?? project.id))
        }) else { return .untracked }
        return .tracked(clone)
    }

    func observe(environmentID: String, client: (any FeatureManagedProjectCloning)?) async {
        let observationID = UUID()
        self.observationID = observationID
        self.environmentID = environmentID
        clones = []
        isPending = true
        errorMessage = nil
        pendingActionID = nil
        do {
            guard let client, try await client.supportsManagedProjectClones(environmentID: environmentID) else {
                return
            }
            try Task.checkCancellation()
            guard self.observationID == observationID else { return }
            for try await clones in client.managedProjectCloneUpdates(environmentID: environmentID) {
                try Task.checkCancellation()
                guard self.observationID == observationID else { return }
                self.clones = clones.filter { $0.environmentID == environmentID }
                isPending = false
                errorMessage = nil
            }
            // Only an authoritative list can release a known new clone.
            if !Task.isCancelled, self.observationID == observationID, isPending {
                errorMessage = "Could not load clone progress. Reconnect or refresh to try again."
            }
        } catch {
            guard !Task.isCancelled, self.observationID == observationID else { return }
            errorMessage = "Could not load clone progress. Reconnect or refresh to try again."
        }
    }

    func perform(_ action: ProjectCloneAction, clone: FeatureManagedProjectClone, client: any FeatureManagedProjectCloning) async {
        guard pendingActionID == nil, clone.environmentID == environmentID else { return }
        let observationID = self.observationID
        pendingActionID = clone.id
        errorMessage = nil
        defer { if self.observationID == observationID { pendingActionID = nil } }
        do {
            let applied = try await client.performManagedProjectCloneAction(action, clone: clone)
            guard self.observationID == observationID else { return }
            if !applied { errorMessage = "The clone has changed. Refresh its status before trying again." }
        } catch is CancellationError {
        } catch {
            guard self.observationID == observationID else { return }
            errorMessage = "Could not \(action == .cancel ? "cancel" : "retry") the clone. Check the connection and try again."
        }
    }

    func remove(_ clone: FeatureManagedProjectClone, client: any FeatureManagedProjectCloning) async -> Bool {
        guard pendingActionID == nil, clone.environmentID == environmentID else { return false }
        let observationID = self.observationID
        pendingActionID = clone.id
        errorMessage = nil
        defer { if self.observationID == observationID { pendingActionID = nil } }
        do {
            try await client.removeManagedCloneProject(clone)
            guard self.observationID == observationID else { return false }
            clones.removeAll { $0.id == clone.id }
            return true
        } catch is CancellationError {
            return false
        } catch {
            guard self.observationID == observationID else { return false }
            errorMessage = "Could not remove this project. Check the connection and try again."
            return false
        }
    }
}
