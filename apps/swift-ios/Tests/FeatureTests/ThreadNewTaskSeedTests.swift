import Foundation
import Testing
@testable import T3Code

@Suite("New thread on this checkout")
struct ThreadNewTaskSeedTests {
    @Test
    func derivesTheExactProjectEnvironmentBranchAndWorktree() throws {
        let thread = makeThread(
            branch: " feature/menu ",
            worktreePath: "/worktrees/menu/../menu"
        )

        let availability = ThreadNewTaskSeedModel.availability(
            for: thread,
            projects: [project]
        )
        guard case let .available(request) = availability else {
            Issue.record("Expected a same-checkout request")
            return
        }

        #expect(request.sourceThreadID == thread.id)
        #expect(request.projectID == project.id)
        #expect(request.environmentID == project.environmentID)
        #expect(request.branch == "feature/menu")
        #expect(request.worktreePath == "/worktrees/menu")
        #expect(request.projectRootPath == nil)
        #expect(availability.menuTitle == "New thread on feature/menu")
    }

    @Test
    func missingMetadataAndUnavailableOwnershipStayExplicitlyDisabled() {
        #expect(availability(branch: " ") == .unavailable(.missingBranch))
        #expect(
            ThreadNewTaskSeedModel.availability(
                for: makeThread(),
                projects: []
            ) == .unavailable(.projectUnavailable)
        )
        #expect(
            ThreadNewTaskSeedModel.availability(
                for: makeThread(environmentID: "other-environment"),
                projects: [project]
            ) == .unavailable(.environmentUnavailable)
        )
        #expect(
            availability(worktreePath: " ") == .unavailable(.worktreeUnavailable)
        )
        #expect(!ThreadNewTaskAvailability.unavailable(.missingBranch).isEnabled)
    }

    @Test
    func resolvesOnlyTheExactLiveBranchAndWorktree() throws {
        let request = try request(
            for: makeThread(worktreePath: "/worktrees/menu")
        )
        let exact = FeatureWorkspaceBranch(
            name: "feature/menu",
            worktreePath: "/worktrees/menu"
        )
        let sameNameWrongCheckout = FeatureWorkspaceBranch(
            name: "feature/menu",
            worktreePath: "/worktrees/other"
        )

        let resolved = ThreadNewTaskSeedModel.resolve(
            request,
            currentThread: makeThread(worktreePath: "/worktrees/menu"),
            projects: [project],
            branches: [sameNameWrongCheckout, exact]
        )
        guard case let .success(seed) = resolved else {
            Issue.record("Expected the exact worktree to resolve")
            return
        }
        #expect(seed.branch == exact)

        let missingBranch = ThreadNewTaskSeedModel.revalidate(
            seed,
            projects: [project],
            branches: []
        )
        guard case let .failure(missingBranchReason) = missingBranch else {
            Issue.record("A deleted branch must be reported explicitly")
            return
        }
        #expect(missingBranchReason == .branchUnavailable)

        let deleted = ThreadNewTaskSeedModel.revalidate(
            seed,
            projects: [project],
            branches: [sameNameWrongCheckout]
        )
        guard case let .failure(reason) = deleted else {
            Issue.record("A deleted worktree must not fall back by branch name")
            return
        }
        #expect(reason == .worktreeUnavailable)
    }

    @Test
    func preservesLegalWhitespaceInTheRecordedWorktreePath() throws {
        let thread = makeThread(worktreePath: "/worktrees/topic ")
        let request = try request(for: thread)
        let exact = FeatureWorkspaceBranch(
            name: "feature/menu",
            worktreePath: "/worktrees/topic "
        )

        #expect(request.worktreePath == "/worktrees/topic ")
        guard case let .success(seed) = ThreadNewTaskSeedModel.resolve(
            request,
            currentThread: thread,
            projects: [project],
            branches: [exact]
        ) else {
            Issue.record("A legal trailing space must remain part of the checkout path")
            return
        }
        #expect(seed.branch == exact)
    }

    @Test
    func currentCheckoutRequiresTheCurrentBranchAtTheProjectRoot() throws {
        let request = try request(for: makeThread(worktreePath: nil))
        #expect(request.projectRootPath == "/repo")
        let detachedSameName = FeatureWorkspaceBranch(name: "feature/menu")
        let current = FeatureWorkspaceBranch(
            name: "feature/menu",
            isCurrent: true,
            worktreePath: "/repo/./"
        )

        let missingCurrent = ThreadNewTaskSeedModel.resolve(
            request,
            currentThread: makeThread(worktreePath: nil),
            projects: [project],
            branches: [detachedSameName]
        )
        guard case let .failure(reason) = missingCurrent else {
            Issue.record("A non-current branch must not replace the source checkout")
            return
        }
        #expect(reason == .worktreeUnavailable)

        guard case let .success(seed) = ThreadNewTaskSeedModel.resolve(
            request,
            currentThread: makeThread(worktreePath: nil),
            projects: [project],
            branches: [current]
        ) else {
            Issue.record("Expected the current root checkout to resolve")
            return
        }
        #expect(seed.branch == current)
    }

    @Test
    func rootCheckoutRejectsAProjectPathThatChangedAfterTheMenuOpened() throws {
        let thread = makeThread(worktreePath: nil)
        let request = try request(for: thread)
        let movedProject = FeatureProject(
            id: project.id,
            environmentID: project.environmentID,
            name: project.name,
            path: "/moved-repo"
        )
        let current = FeatureWorkspaceBranch(
            name: "feature/menu",
            isCurrent: true,
            worktreePath: "/moved-repo"
        )

        let resolution = ThreadNewTaskSeedModel.resolve(
            request,
            currentThread: thread,
            projects: [movedProject],
            branches: [current]
        )
        guard case let .failure(resolveReason) = resolution else {
            Issue.record("A stale root checkout request must be rejected")
            return
        }
        #expect(resolveReason == .threadChanged)

        let seed = ThreadNewTaskResolvedSeed(request: request, branch: current)
        let revalidation = ThreadNewTaskSeedModel.revalidate(
            seed,
            projects: [movedProject],
            branches: [current]
        )
        guard case let .failure(revalidateReason) = revalidation else {
            Issue.record("A moved project root must not be applied to the composer")
            return
        }
        #expect(revalidateReason == .threadChanged)
    }

    @Test
    func staleRowRequestCannotReuseAChangedThreadIdentity() throws {
        let original = makeThread(branch: "feature/menu")
        let request = try request(for: original)
        let reusedRow = makeThread(branch: "feature/replacement")

        let resolution = ThreadNewTaskSeedModel.resolve(
            request,
            currentThread: reusedRow,
            projects: [project],
            branches: [
                FeatureWorkspaceBranch(
                    name: "feature/menu",
                    isCurrent: true,
                    worktreePath: "/repo"
                ),
            ]
        )
        guard case let .failure(reason) = resolution else {
            Issue.record("A stale context-menu request must be rejected")
            return
        }
        #expect(reason == .threadChanged)
    }

    @Test
    func eachPresentationIsFreshAndWorkspaceSeedingPreservesTheDraft() throws {
        let request = try request(
            for: makeThread(worktreePath: "/worktrees/menu")
        )
        let seed = ThreadNewTaskResolvedSeed(
            request: request,
            branch: FeatureWorkspaceBranch(
                name: request.branch,
                worktreePath: request.worktreePath
            )
        )
        let first = ThreadNewTaskPresentation.sameBranch(seed)
        let second = ThreadNewTaskPresentation.sameBranch(seed)
        let attachment = FeatureDraftAttachment(
            data: Data([1, 2, 3]),
            filename: "proof.png",
            mimeType: "image/png"
        )
        let selection = FeatureSelection(providerID: "codex", modelID: "gpt-5")
        let draft = FeatureComposerDraft(
            text: "Keep my draft",
            attachments: [attachment],
            selection: selection,
            workspace: FeatureComposerWorkspaceDraft(
                mode: .worktree,
                branch: "old",
                worktreePath: nil,
                startFromOrigin: true
            )
        )

        #expect(first.id != second.id)
        #expect(first.initialProjectID == project.id)
        #expect(seed.belongs(to: project.id))
        #expect(!seed.belongs(to: "another-project"))
        let seeded = seed.applying(to: draft)
        #expect(seeded.text == draft.text)
        #expect(seeded.attachments == draft.attachments)
        #expect(seeded.selection == draft.selection)
        #expect(seeded.workspace == FeatureComposerWorkspaceDraft(
            mode: .local,
            branch: "feature/menu",
            worktreePath: "/worktrees/menu",
            startFromOrigin: false
        ))
    }

    private var project: FeatureProject {
        FeatureProject(
            id: "project-1",
            environmentID: "environment-1",
            name: "Project",
            path: "/repo"
        )
    }

    private func makeThread(
        environmentID: String? = "environment-1",
        branch: String? = "feature/menu",
        worktreePath: String? = nil
    ) -> FeatureThread {
        FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            environmentID: environmentID,
            title: "Menu",
            branch: branch,
            worktreePath: worktreePath
        )
    }

    private func availability(
        branch: String? = "feature/menu",
        worktreePath: String? = nil
    ) -> ThreadNewTaskAvailability {
        ThreadNewTaskSeedModel.availability(
            for: makeThread(branch: branch, worktreePath: worktreePath),
            projects: [project]
        )
    }

    private func request(for thread: FeatureThread) throws -> ThreadNewTaskSeedRequest {
        guard case let .available(request) = ThreadNewTaskSeedModel.availability(
            for: thread,
            projects: [project]
        ) else {
            throw ThreadNewTaskUnavailableReason.projectUnavailable
        }
        return request
    }
}
