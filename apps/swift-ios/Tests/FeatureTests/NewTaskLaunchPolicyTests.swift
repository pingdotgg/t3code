import Foundation
import Testing
@testable import T3Code

@Suite("New task launch context")
struct NewTaskLaunchPolicyTests {
    @Test
    func sourceKeepsTheExactPhysicalProjectEvenWhenAnotherProjectIsAvailable() {
        #expect(NewTaskLaunchPolicy.initialProjectID(
            sourceThread: source, recoveryRequested: false, recoveryProjectID: nil,
            requestedProjectID: "different-project", fallbackProjectID: "online-project"
        ) == "source-project")
        #expect(NewTaskLaunchPolicy.initialProjectID(
            sourceThread: nil, recoveryRequested: true, recoveryProjectID: "removed-project",
            requestedProjectID: nil, fallbackProjectID: "online-project"
        ) == "removed-project")
        #expect(NewTaskLaunchPolicy.initialProjectID(
            sourceThread: nil, recoveryRequested: true, recoveryProjectID: nil,
            requestedProjectID: nil, fallbackProjectID: "online-project"
        ).isEmpty)
    }

    @Test
    func sourceUsesItsExistingWorktreeAndNeverCreatesASecondOne() throws {
        let workspace = try #require(NewTaskWorkspaceSeed(thread: source).workspace(for: project))
        #expect(workspace.mode == .local)
        #expect(workspace.branch == "feature")
        #expect(workspace.worktreePath == "/worktrees/exact-source")
        #expect(!workspace.startFromOrigin)
        var differentEnvironment = project
        differentEnvironment.environmentID = "other"
        #expect(NewTaskWorkspaceSeed(thread: source).workspace(for: differentEnvironment) == nil)
    }

    @Test
    func sourceWorkspaceWinsWhileSavedPromptAndModeChoicesRestore() throws {
        let seededWorkspace = try #require(NewTaskWorkspaceSeed(thread: source).workspace(for: project))
        let saved = FeatureComposerDraft(
            text: "Keep these unsent notes",
            workspace: .init(mode: .worktree, branch: "main", worktreePath: nil, startFromOrigin: true),
            runtimeMode: .approvalRequired, interactionMode: .plan
        )
        let context = NewTaskDraftRestoreContext(projectID: project.id, baseline: .init())
        let restored = try context.merging(
            saved: saved, current: .init(workspace: seededWorkspace)
        )
        #expect(restored.text == saved.text)
        #expect(restored.workspace == seededWorkspace)
        #expect(restored.runtimeMode == .approvalRequired)
        #expect(restored.interactionMode == .plan)
    }

    @Test
    func unconfirmedRootSeedStaysLiveButIsNotSavedUntilCheckoutSucceeds() throws {
        var thread = source
        thread.worktreePath = nil
        let workspace = try #require(NewTaskWorkspaceSeed(thread: thread).workspace(for: project))
        let live = FeatureComposerDraft(workspace: workspace)
        let beforeRestore = NewTaskLaunchPolicy.draftForPersistence(live, needsInitialBranchCheckout: true)
        #expect(beforeRestore.isEmpty)
        #expect(live.workspace == workspace)

        let saved = FeatureComposerDraft(
            text: "Keep these unsent notes",
            workspace: .init(mode: .worktree, branch: "main", worktreePath: nil, startFromOrigin: true),
            runtimeMode: .approvalRequired, interactionMode: .plan
        )
        let context = NewTaskDraftRestoreContext(projectID: project.id, baseline: .init())
        let restored = try context.merging(saved: saved, current: live)
        #expect(restored.workspace == workspace)

        let pending = NewTaskLaunchPolicy.draftForPersistence(restored, needsInitialBranchCheckout: true)
        #expect(pending.workspace == nil)
        #expect(pending.text == saved.text)
        #expect(pending.runtimeMode == .approvalRequired)
        #expect(pending.interactionMode == .plan)
        #expect(restored.workspace == workspace)
        let plainNewTask = try context.merging(saved: pending, current: .init())
        #expect(plainNewTask.workspace == nil)
        #expect(plainNewTask.text == saved.text)

        let confirmed = NewTaskLaunchPolicy.draftForPersistence(restored, needsInitialBranchCheckout: false)
        #expect(confirmed == restored)
    }

    @Test
    func branchRefreshCannotMoveAnExplicitWorkspaceOrDropAnOfflineSelection() {
        let selected = FeatureWorkspaceBranch(name: "feature", worktreePath: "/worktrees/exact-source")
        let refreshed = NewTaskLaunchPolicy.refreshedBranch(
            selected, in: [.init(name: "feature", isCurrent: true, worktreePath: "/other-checkout")],
            mode: .local, isExplicit: true
        )
        #expect(refreshed?.worktreePath == "/worktrees/exact-source")
        #expect(NewTaskLaunchPolicy.refreshedBranch(
            selected, in: [.init(name: "main", isCurrent: true)], mode: .local, isExplicit: true
        ) == selected)
        #expect(NewTaskLaunchPolicy.refreshedBranch(
            nil, in: [.init(name: "main", isCurrent: true)], mode: .local, isExplicit: false
        )?.name == "main")
    }

    @Test
    func sourceWithoutAWorktreeKeepsTheProjectCheckout() throws {
        var thread = source
        thread.worktreePath = nil
        let workspace = try #require(NewTaskWorkspaceSeed(thread: thread).workspace(for: project))
        #expect(workspace.mode == .local)
        #expect(workspace.worktreePath == nil)
        let selected = FeatureWorkspaceBranch(name: "feature")
        #expect(NewTaskLaunchPolicy.refreshedBranch(
            selected, in: [.init(name: "feature", worktreePath: "/different")],
            mode: .local, isExplicit: true
        )?.worktreePath == nil)
    }

    @Test @MainActor
    func historicalRootBranchWaitsForCheckoutEvenWhenTheCachedListSaysCurrent() async throws {
        let cached = FeatureWorkspaceBranch(name: "feature", isCurrent: true, worktreePath: "/repo/./")
        let branch = NewTaskLaunchPolicy.seededBranchForCheckout(cached, projectPath: project.path)
        let (started, startedContinuation) = AsyncStream<String>.makeStream()
        let (release, releaseContinuation) = AsyncStream<Void>.makeStream()
        var selected: FeatureWorkspaceBranch?
        let preparation = Task {
            defer { startedContinuation.finish() }
            selected = try await NewTaskWorkspaceDefaults.selectBranch(branch, mode: .local) { name in
                startedContinuation.yield(name)
                startedContinuation.finish()
                for await _ in release {}
                return name
            }
        }
        var requested: [String] = []
        for await name in started { requested.append(name) }
        #expect(requested == ["feature"])
        #expect(selected == nil)
        releaseContinuation.finish()
        try await preparation.value
        #expect(selected?.name == "feature")
        #expect(selected?.isCurrent == true)
        #expect(selected?.worktreePath == nil)
    }

    @Test @MainActor
    func failedHistoricalCheckoutDoesNotResolveAndAnExistingWorktreeNeedsNoCheckout() async throws {
        let root = NewTaskLaunchPolicy.seededBranchForCheckout(.init(name: "feature"), projectPath: project.path)
        var selected: FeatureWorkspaceBranch?
        do {
            selected = try await NewTaskWorkspaceDefaults.selectBranch(root, mode: .local) { _ in
                throw URLError(.notConnectedToInternet)
            }
            Issue.record("A historical branch must not resolve after a failed checkout")
        } catch {
            #expect((error as? URLError)?.code == .notConnectedToInternet)
        }
        #expect(selected == nil)

        let worktree = NewTaskLaunchPolicy.seededBranchForCheckout(
            .init(name: "feature", worktreePath: "/worktrees/exact-source"), projectPath: project.path
        )
        let existing = try await NewTaskWorkspaceDefaults.selectBranch(worktree, mode: .local) { _ in
            Issue.record("An existing worktree must not check out the project root")
            throw URLError(.notConnectedToInternet)
        }
        #expect(existing.name == "feature")
        #expect(existing.worktreePath == "/worktrees/exact-source")
    }

    @Test
    func savedPlanDraftLaunchesInBuildUnlessBothPreferenceAndProviderAllowPlan() throws {
        let saved = FeatureComposerDraft(text: "Saved prompt", interactionMode: .plan)
        let restored = try NewTaskDraftRestoreContext(projectID: project.id, baseline: .init())
            .merging(saved: saved, current: .init())
        var provider = FeatureProvider(id: "provider", name: "Provider")
        #expect(NewTaskLaunchPolicy.interactionMode(
            draft: restored.interactionMode, legacyPlanModeEnabled: false, provider: provider
        ) == .standard)
        #expect(NewTaskLaunchPolicy.interactionMode(
            draft: restored.interactionMode, legacyPlanModeEnabled: true, provider: provider
        ) == .plan)
        provider.showInteractionModeToggle = false
        #expect(NewTaskLaunchPolicy.interactionMode(
            draft: restored.interactionMode, legacyPlanModeEnabled: true, provider: provider
        ) == .standard)
        #expect(NewTaskLaunchPolicy.interactionMode(
            draft: nil, legacyPlanModeEnabled: true, provider: nil
        ) == .standard)
    }

    private var project: FeatureProject {
        .init(id: "source-project", environmentID: "source-environment", name: "Source", path: "/repo")
    }

    private var source: FeatureThread {
        .init(
            id: "source-thread", projectID: "source-project", environmentID: "source-environment",
            title: "Source", branch: "feature", worktreePath: "/worktrees/exact-source"
        )
    }
}
