import Foundation
import Testing
@testable import T3Code

@Suite("Commit and workspace parity")
struct FeatureSourceControlParityTests {
    private let files: [FeatureSourceControlFile] = [
        .init(path: "src/a.swift", state: .modified, isStaged: false),
        .init(path: "name, with spaces.swift", state: .added, isStaged: true),
    ]

    @Test func commitFileSelectionAndEmptyMessageRemainDistinct() {
        var selection = FeatureCommitSelection(files: files)
        #expect(selection.filePaths(in: files) == nil)
        selection.paths.remove("src/a.swift")
        let request = FeatureSourceControlRequest(action: .commitAndPush, message: " \n ", filePaths: selection.filePaths(in: files), featureBranch: true)
        #expect(request.message == nil)
        #expect(request.filePaths == ["name, with spaces.swift"])
        #expect(request.featureBranch)
        selection.paths.removeAll()
        #expect(selection.filePaths(in: files) == [])
    }

    @Test func defaultBranchChoiceAppliesToEveryPublishingAction() {
        let status = FeatureSourceControlStatus(branch: "main", hasPrimaryRemote: true, isDefaultBranch: true)
        for action in [FeatureSourceControlAction.push, .createPullRequest, .commitAndPush, .commitPushAndCreatePullRequest] {
            let request = FeatureSourceControlRequest(action: action, filePaths: ["src/a.swift"])
            #expect(request.requiresBranchChoice(status))
            var onBranch = request
            onBranch.allowDefaultBranch = true
            #expect(!onBranch.requiresBranchChoice(status))
            var feature = request
            feature.featureBranch = true
            #expect(!feature.requiresBranchChoice(status))
            #expect(feature.filePaths == request.filePaths)
        }
        #expect(!FeatureSourceControlRequest(action: .commit).requiresBranchChoice(status))
        #expect(!FeatureSourceControlRequest(action: .pull).requiresBranchChoice(status))
    }

    @Test func knownRemoteFactsControlActions() {
        let local = FeatureSourceControlStatus(branch: "main", aheadCount: 2, files: files, hasPrimaryRemote: false, isDefaultBranch: true)
        #expect(local.availableActions == [.commit])
        let behind = FeatureSourceControlStatus(branch: "feature/fix", aheadCount: 2, behindCount: 1, files: files, hasPrimaryRemote: true)
        #expect(behind.availableActions == [.commit, .pull])
        let unpublished = FeatureSourceControlStatus(branch: "feature/fix", aheadCount: 1, hasPrimaryRemote: true, hasUpstream: false)
        #expect(unpublished.availableActions.contains(.push))
        #expect(unpublished.availableActions.contains(.createPullRequest))
        let unknown = FeatureSourceControlStatus(branch: "feature/fix", isRemoteKnown: false, files: files, hasPrimaryRemote: true)
        #expect(unknown.availableActions == [.commit])
    }

    @Test func passiveSnapshotWithoutRemoteDataRemainsUnknown() throws {
        var accumulator = NativeSourceControlStatusAccumulator()
        let local = VCSLocalStatus(isRepo: true, sourceControlProvider: nil,
            hasPrimaryRemote: true, isDefaultRef: false, refName: "feature/fix", hasWorkingTreeChanges: false,
            workingTree: .init(files: [], insertions: 0, deletions: 0))
        let passiveValue = accumulator.consume(.snapshot(local: local, remote: nil))
        let passive = try #require(passiveValue)
        #expect(!passive.isRemoteKnown)
        #expect(!accumulator.isComplete)
        let resolvedValue = accumulator.consume(.remoteUpdated(nil))
        let resolved = try #require(resolvedValue)
        #expect(resolved.isRemoteKnown)
        #expect(accumulator.isComplete)
    }

    @Test func commitDestinationOpensFromLocalStatusBeforeRemoteStatusArrives() {
        let local = VCSLocalStatus(isRepo: true, sourceControlProvider: nil,
            hasPrimaryRemote: true, isDefaultRef: false, refName: "feature/fix", hasWorkingTreeChanges: true,
            workingTree: .init(files: [.init(path: "a.swift", insertions: 1, deletions: 0)], insertions: 1, deletions: 0))
        let status = NativeWorkspaceMapper.sourceControl(local: local, remote: nil, isRemoteKnown: false)
        #expect(!status.isRemoteKnown)
        #expect(status.hasPrimaryRemote == true)
        #expect(FeatureSourceControlDestinationPolicy.shouldOpenCommit(
            destination: .gitCommit, handledDestination: nil, status: status
        ))
        // A later remote result must not reopen a dismissed commit sheet.
        var remoteKnown = status
        remoteKnown.isRemoteKnown = true
        for next in [status, remoteKnown] {
            #expect(!FeatureSourceControlDestinationPolicy.shouldOpenCommit(
                destination: .gitCommit, handledDestination: .gitCommit, status: next
            ))
        }
    }

    @Test func commitDestinationRequiresAnIdleRepositoryWithLocalChanges() {
        let unavailable: [FeatureSourceControlStatus?] = [
            nil,
            .init(isRemoteKnown: false),
            .init(isRepository: false, isRemoteKnown: false, files: files),
            .init(isRemoteKnown: false, files: files, isBusy: true),
        ]
        for status in unavailable {
            #expect(!FeatureSourceControlDestinationPolicy.shouldOpenCommit(
                destination: .gitCommit, handledDestination: nil, status: status
            ))
        }
        let localOnly = FeatureSourceControlStatus(isRemoteKnown: false, files: files, hasPrimaryRemote: false)
        #expect(FeatureSourceControlDestinationPolicy.shouldOpenCommit(
            destination: .gitCommit, handledDestination: nil, status: localOnly
        ))
    }

    @Test func localChangesDoNotOpenCommitForOtherDestinations() {
        let status = FeatureSourceControlStatus(isRemoteKnown: false, files: files)
        let destinations: [FeatureThreadDestination?] = [nil, .git, .gitBranches, .review]
        for destination in destinations {
            #expect(!FeatureSourceControlDestinationPolicy.shouldOpenCommit(
                destination: destination, handledDestination: nil, status: status
            ))
        }
        #expect(FeatureSourceControlDestinationPolicy.shouldOpenCommit(
            destination: .gitCommit, handledDestination: .gitBranches, status: status
        ))
    }

    @Test func nativeStatusMappingRetainsBranchAndRemoteFacts() {
        let local = VCSLocalStatus(isRepo: true, sourceControlProvider: nil,
            hasPrimaryRemote: false, isDefaultRef: true, refName: "main", hasWorkingTreeChanges: true,
            workingTree: .init(files: [.init(path: "a.swift", insertions: 1, deletions: 0)], insertions: 1, deletions: 0))
        let mapped = NativeWorkspaceMapper.sourceControl(local: local, remote: nil, isRemoteKnown: false)
        #expect(mapped.hasPrimaryRemote == false)
        #expect(mapped.isDefaultBranch == true)
        #expect(mapped.hasUpstream == nil)
        #expect(mapped.availableActions == [.commit])
    }

    @Test func oldStoredStatusKeepsBackwardCompatibleDefaults() throws {
        let json = Data(#"{"isRepository":true,"branch":"main","aheadCount":0,"behindCount":0,"isRemoteKnown":true,"files":[],"isBusy":false}"#.utf8)
        let status = try JSONDecoder.t3.decode(FeatureSourceControlStatus.self, from: json)
        #expect(status.hasPrimaryRemote == nil)
        #expect(status.isDefaultBranch == nil)
    }

    @Test func metadataFailureRetainsOnlyUnfinishedWork() {
        let request = FeatureSourceControlRequest(action: .commit, message: "Fix", filePaths: ["src/a.swift"], featureBranch: true)
        let workspace = FeatureSourceControlWorkspace(branch: "feature/fix", worktreePath: "/worktree")
        let failure = FeatureSourceControlWorkspaceSyncError(workspace: workspace, pendingRequest: nil, message: "Disconnected")
        var recovery = FeatureToolFailureState<FeatureGitOperation>()
        recovery.recordFollowUpFailure(.syncWorkspace(workspace, then: nil), afterCompletionOf: .action(request), error: failure)
        #expect(recovery.retryOperation == .syncWorkspace(workspace, then: nil))
        #expect(recovery.retryOperation != .action(request))
    }

    @Test func aBranchInThisWorkspaceIsAvailableButAnotherWorktreeIsNot() {
        let current = FeatureWorkspaceBranch(name: "feature/current", isCurrent: true, worktreePath: "/repo/worktree")
        let elsewhere = FeatureWorkspaceBranch(name: "main", worktreePath: "/repo")
        let free = FeatureWorkspaceBranch(name: "feature/free")
        let branches = FeatureSourceControlBranches(branches: [current, elsewhere, free], workspace: .init(branch: current.name, worktreePath: "/repo/worktree"), workingDirectory: "/repo/worktree")
        #expect(branches.isAvailable(current))
        #expect(!branches.isAvailable(elsewhere))
        #expect(branches.isAvailable(free))
    }

    @Test func invalidBranchesAreRejectedAndAutomaticNamesAvoidCollisions() throws {
        #expect(try FeatureGitBranchName.validated(" feature/my-fix ") == "feature/my-fix")
        for name in ["", "a..b", "a b", "-bad", "x/.hidden", "x.lock", "a//b", "a@{b", "a\\b"] {
            #expect(throws: RPCError.self) { try FeatureGitBranchName.validated(name) }
        }
        #expect(FeatureGitBranchName.automatic(existing: ["FEATURE/UPDATE", "feature/update-2"]) == "feature/update-3")
    }
}
