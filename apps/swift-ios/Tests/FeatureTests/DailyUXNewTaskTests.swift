import Foundation
import Testing
import UIKit
@testable import T3Code

@Suite("Message-first task creation")
struct DailyUXNewTaskTests {
    @Test
    func recentProjectRankingDrivesTheDefaultAndKeepsUnusedProjectsOut() {
        let alpha = rankedProject("alpha", name: "Alpha")
        let beta = rankedProject("beta", name: "Beta")
        let unused = rankedProject("unused", name: "Unused")
        let value = rankedSnapshot(
            projects: [unused, beta, alpha],
            threads: [
                rankedThread("older", projectID: alpha.id, activity: 10),
                rankedThread("newer", projectID: beta.id, activity: 20),
            ]
        )

        let ranking = DailyUXCreationContext.recentProjects(in: value)

        #expect(ranking.map(\.project.id) == [beta.id, alpha.id])
        #expect(
            DailyUXCreationContext.initialProject(in: value, requestedProjectID: nil)?.id
                == ranking.first?.project.id
        )
    }

    @Test
    func recentProjectRankingIsStableForTiesAndIgnoresMissingProjects() {
        let alpha = rankedProject("alpha", name: "Alpha")
        let beta = rankedProject("beta", name: "Beta")
        let value = rankedSnapshot(
            projects: [alpha, beta],
            threads: [
                rankedThread("z-thread", projectID: alpha.id, activity: 20),
                rankedThread("missing", projectID: "missing", activity: 30),
                rankedThread("a-thread", projectID: beta.id, activity: 20),
            ]
        )

        #expect(
            DailyUXCreationContext.recentProjects(in: value)
                .map(\.project.id) == [beta.id, alpha.id]
        )
    }

    @Test
    func recentProjectRankingUsesActivityInsteadOfMetadataChanges() {
        let alpha = rankedProject("alpha", name: "Alpha")
        let beta = rankedProject("beta", name: "Beta")
        let value = rankedSnapshot(
            projects: [alpha, beta],
            threads: [
                rankedThread(
                    "metadata-change",
                    projectID: alpha.id,
                    updatedAt: 100,
                    lastActivityAt: 10
                ),
                rankedThread("actual-use", projectID: beta.id, activity: 20),
            ]
        )

        #expect(
            DailyUXCreationContext.recentProjects(in: value)
                .map(\.project.id) == [beta.id, alpha.id]
        )
    }

    @Test
    func archivedAndSettledThreadsStillRepresentProjectUse() {
        let archived = rankedProject("archived", name: "Archived")
        let settled = rankedProject("settled", name: "Settled")
        let value = rankedSnapshot(
            projects: [archived, settled],
            threads: [
                rankedThread(
                    "archived-thread",
                    projectID: archived.id,
                    activity: 30,
                    isArchived: true
                ),
                rankedThread(
                    "settled-thread",
                    projectID: settled.id,
                    activity: 20,
                    isSettled: true
                ),
            ]
        )

        #expect(
            DailyUXCreationContext.recentProjects(in: value)
                .map(\.project.id) == [archived.id, settled.id]
        )
    }

    @Test
    func explicitProjectWinsAndNoActivityFallsBackAlphabetically() {
        let zulu = rankedProject("zulu", name: "Zulu")
        let alpha = rankedProject("alpha", name: "Alpha")
        let withActivity = rankedSnapshot(
            projects: [zulu, alpha],
            threads: [rankedThread("recent", projectID: zulu.id, activity: 20)]
        )
        let withoutActivity = rankedSnapshot(projects: [zulu, alpha], threads: [])

        #expect(
            DailyUXCreationContext.initialProject(
                in: withActivity,
                requestedProjectID: alpha.id
            )?.id == alpha.id
        )
        #expect(DailyUXCreationContext.recentProjects(in: withoutActivity).isEmpty)
        #expect(
            DailyUXCreationContext.initialProject(
                in: withoutActivity,
                requestedProjectID: nil
            )?.id == alpha.id
        )
    }

    @Test
    func recentProjectRankingExcludesDisabledEnvironments() {
        let enabled = rankedProject("enabled", name: "Enabled", environmentID: "enabled-env")
        let disabled = rankedProject("disabled", name: "Disabled", environmentID: "disabled-env")
        let value = rankedSnapshot(
            environments: [
                FeatureEnvironment(
                    id: "enabled-env",
                    name: "Enabled",
                    endpoint: "http://enabled",
                    isEnabled: true
                ),
                FeatureEnvironment(
                    id: "disabled-env",
                    name: "Disabled",
                    endpoint: "http://disabled",
                    isEnabled: false
                ),
            ],
            projects: [enabled, disabled],
            threads: [
                rankedThread("enabled-thread", projectID: enabled.id, activity: 10),
                rankedThread("disabled-thread", projectID: disabled.id, activity: 20),
            ]
        )

        #expect(
            DailyUXCreationContext.recentProjects(in: value).map(\.project.id) == [enabled.id]
        )
    }

    @Test
    func recentProjectRankingDeduplicatesARepositoryAcrossEnvironments() {
        let local = rankedProject(
            "local",
            name: "Project",
            environmentID: "local-env",
            repositoryKey: "github.com/example/project"
        )
        let remote = rankedProject(
            "remote",
            name: "Project",
            environmentID: "remote-env",
            repositoryKey: "github.com/example/project"
        )
        let value = rankedSnapshot(
            environments: [
                FeatureEnvironment(
                    id: "local-env",
                    name: "Local",
                    endpoint: "http://local"
                ),
                FeatureEnvironment(
                    id: "remote-env",
                    name: "Remote",
                    endpoint: "http://remote"
                ),
            ],
            projects: [local, remote],
            threads: [
                rankedThread(
                    "local-thread",
                    projectID: local.id,
                    environmentID: "local-env",
                    activity: 10
                ),
                rankedThread(
                    "remote-thread",
                    projectID: remote.id,
                    environmentID: "remote-env",
                    activity: 20
                ),
            ]
        )

        let ranking = DailyUXCreationContext.recentProjects(in: value)
        #expect(ranking.count == 1)
        #expect(ranking.first?.project.id == remote.id)
    }

    @Test
    func recentProjectRankingKeepsTheExactWorktreeUsedByTheThread() {
        let root = rankedProject(
            "root",
            name: "Project",
            repositoryKey: "github.com/example/project"
        )
        let worktree = rankedProject(
            "worktree",
            name: "Project",
            repositoryKey: "github.com/example/project"
        )
        let value = rankedSnapshot(
            projects: [root, worktree],
            threads: [rankedThread("recent", projectID: worktree.id, activity: 20)]
        )

        #expect(DailyUXCreationContext.recentProjects(in: value).first?.project.id == worktree.id)
        #expect(
            DailyUXCreationContext.initialProject(
                in: value,
                requestedProjectID: worktree.id
            )?.id == worktree.id
        )
    }

    @Test
    func automaticProjectAdoptionWaitsForRestoreAndStopsAfterExplicitChoices() {
        #expect(
            DailyUXCreationContext.shouldAdoptAutomaticProject(
                currentProjectID: "fallback",
                nextRecentProjectID: "recent",
                isAwaitingRecentActivity: true,
                projectSelectionIsExplicit: false,
                modelSelectionIsExplicit: false,
                workspaceSelectionIsExplicit: false,
                hasDraftContent: false,
                draftRestoreIsComplete: true
            )
        )

        for explicitChoice in 0..<3 {
            #expect(
                !DailyUXCreationContext.shouldAdoptAutomaticProject(
                    currentProjectID: "fallback",
                    nextRecentProjectID: "recent",
                    isAwaitingRecentActivity: true,
                    projectSelectionIsExplicit: explicitChoice == 0,
                    modelSelectionIsExplicit: explicitChoice == 1,
                    workspaceSelectionIsExplicit: explicitChoice == 2,
                    hasDraftContent: false,
                    draftRestoreIsComplete: true
                )
            )
        }
        #expect(
            !DailyUXCreationContext.shouldAdoptAutomaticProject(
                currentProjectID: "fallback",
                nextRecentProjectID: "recent",
                isAwaitingRecentActivity: true,
                projectSelectionIsExplicit: false,
                modelSelectionIsExplicit: false,
                workspaceSelectionIsExplicit: false,
                hasDraftContent: false,
                draftRestoreIsComplete: false
            )
        )
        #expect(
            !DailyUXCreationContext.shouldAdoptAutomaticProject(
                currentProjectID: "fallback",
                nextRecentProjectID: "recent",
                isAwaitingRecentActivity: true,
                projectSelectionIsExplicit: false,
                modelSelectionIsExplicit: false,
                workspaceSelectionIsExplicit: false,
                hasDraftContent: true,
                draftRestoreIsComplete: true
            )
        )
        #expect(
            !DailyUXCreationContext.shouldAdoptAutomaticProject(
                currentProjectID: "fallback",
                nextRecentProjectID: "fallback",
                isAwaitingRecentActivity: true,
                projectSelectionIsExplicit: false,
                modelSelectionIsExplicit: false,
                workspaceSelectionIsExplicit: false,
                hasDraftContent: false,
                draftRestoreIsComplete: true
            )
        )
        #expect(
            !DailyUXCreationContext.shouldAdoptAutomaticProject(
                currentProjectID: "fallback",
                nextRecentProjectID: nil,
                isAwaitingRecentActivity: true,
                projectSelectionIsExplicit: false,
                modelSelectionIsExplicit: false,
                workspaceSelectionIsExplicit: false,
                hasDraftContent: false,
                draftRestoreIsComplete: true
            )
        )
    }

    @Test
    func requestNormalizesLegacyModesAndKeepsImageBytes() {
        let image = FeatureDraftAttachment(
            data: Data([1, 2, 3]),
            filename: "Image 1.jpg",
            mimeType: "image/jpeg"
        )
        let request = NewTaskRequest(
            projectID: "project",
            prompt: "  Build it  \n",
            selection: FeatureSelection(providerID: "codex", modelID: "gpt-5"),
            runtimeMode: .approvalRequired,
            interactionMode: .plan,
            attachments: [image]
        )

        #expect(request.trimmedPrompt == "Build it")
        #expect(request.runtimeMode == .fullAccess)
        #expect(request.interactionMode == .standard)
        #expect(request.workspaceMode == .local)
        #expect(request.branch == nil)
        #expect(request.worktreePath == nil)
        #expect(!request.startFromOrigin)
        #expect(request.attachments.first?.byteCount == 3)
    }

    @Test
    func worktreeRequestKeepsBaseBranchAndDropsExistingCheckoutPath() {
        let request = NewTaskRequest(
            projectID: "project",
            prompt: "Build it",
            selection: nil,
            runtimeMode: .fullAccess,
            interactionMode: .standard,
            workspaceMode: .worktree,
            branch: "  main ",
            worktreePath: "/existing/worktree",
            startFromOrigin: true
        )

        #expect(request.branch == "main")
        #expect(request.worktreePath == nil)
        #expect(request.startFromOrigin)
    }

    @Test
    func workspaceDefaultsPreferCurrentCheckoutAndLocalDefaultBase() throws {
        let branches = [
            FeatureWorkspaceBranch(name: "origin/main", isRemote: true, isDefault: true),
            FeatureWorkspaceBranch(name: "feature", isCurrent: true),
            FeatureWorkspaceBranch(name: "main", isDefault: true),
        ]

        #expect(NewTaskWorkspaceDefaults.localBranch(in: branches)?.name == "feature")
        #expect(NewTaskWorkspaceDefaults.worktreeBase(in: branches)?.name == "main")

        let root = FeatureWorkspaceBranch(
            name: "feature",
            worktreePath: "/repo/./"
        )
        #expect(
            NewTaskWorkspaceDefaults.normalizedWorktreePath(
                for: root,
                projectPath: "/repo"
            ) == nil
        )

        let linked = FeatureWorkspaceBranch(
            name: "linked",
            worktreePath: "/worktrees/linked"
        )
        #expect(
            NewTaskWorkspaceDefaults.normalizedWorktreePath(
                for: linked,
                projectPath: "/repo"
            ) == "/worktrees/linked"
        )
    }

    @Test
    func mobileModeChoicesOnlyExposeSupportedValues() {
        #expect(FeatureRuntimeMode.allCases == [.fullAccess])
        #expect(FeatureInteractionMode.allCases == [.standard])
    }

    @Test
    func projectDraftRestoreNeverOverwritesTypingMadeWhileLoading() {
        let savedAttachment = FeatureDraftAttachment(
            data: Data([0x01]),
            filename: "saved.png",
            mimeType: "image/png"
        )
        let context = NewTaskDraftRestoreContext(
            projectID: "second-project",
            baseline: FeatureComposerDraft()
        )

        let merged = context.merging(
            saved: FeatureComposerDraft(
                text: "Old saved prompt",
                attachments: [savedAttachment]
            ),
            current: FeatureComposerDraft(text: "Typed while loading")
        )

        #expect(context.projectID == "second-project")
        #expect(merged.text == "Typed while loading")
        #expect(merged.attachments == [savedAttachment])
    }

    @Test
    func passiveProjectsExposeTheirFullEnvironmentModelCatalogAndDefault() throws {
        let passiveDefault = FeatureSelection(
            providerID: "claudeAgent",
            modelID: "claude-opus-4-1"
        )
        let activeProject = FeatureProject(
            id: "active-project",
            environmentID: "active",
            name: "Active",
            path: "/active"
        )
        let passiveProject = FeatureProject(
            id: "passive-project",
            environmentID: "passive",
            name: "Passive",
            path: "/passive",
            defaultSelection: passiveDefault
        )
        let snapshot = FeatureSnapshot(
            connection: .init(state: .connected),
            environments: [
                .init(
                    id: "active",
                    name: "Active",
                    endpoint: "https://active.example",
                    isActive: true,
                    connectionState: .connected
                ),
                .init(
                    id: "passive",
                    name: "Passive",
                    endpoint: "https://passive.example",
                    connectionState: .connected
                ),
                .init(
                    id: "offline",
                    name: "Offline",
                    endpoint: "https://offline.example",
                    connectionState: .disconnected
                ),
            ],
            projects: [
                activeProject,
                passiveProject,
                .init(
                    id: "offline-project",
                    environmentID: "offline",
                    name: "Offline",
                    path: "/offline"
                ),
            ],
            providers: [
                .init(
                    id: "codex",
                    name: "Codex",
                    models: [.init(id: "gpt-5.6-sol", name: "GPT-5.6")]
                ),
            ],
            providersByEnvironment: [
                "passive": [
                    .init(
                        id: "claudeAgent",
                        name: "Claude",
                        models: [
                            .init(id: "claude-opus-4-1", name: "Opus"),
                            .init(id: "claude-sonnet-4", name: "Sonnet"),
                        ]
                    ),
                ],
            ],
            preferencesByEnvironment: [
                "active": .init(
                    defaultWorkspaceMode: .local,
                    newWorktreesStartFromOrigin: true
                ),
                "passive": .init(
                    defaultWorkspaceMode: .worktree,
                    newWorktreesStartFromOrigin: false
                ),
            ]
        )

        #expect(
            DailyUXCreationContext.projects(in: snapshot).map(\.id)
                == ["active-project", "passive-project", "offline-project"]
        )
        let passiveProviders = DailyUXCreationContext.providers(
            for: passiveProject,
            in: snapshot
        )
        #expect(passiveProviders.map(\.id) == ["claudeAgent"])
        #expect(
            passiveProviders.first?.models.map(\.id)
                == ["claude-opus-4-1", "claude-sonnet-4"]
        )
        #expect(
            DailyUXCreationContext.initialSelection(for: passiveProject, in: snapshot)
                == passiveDefault
        )
        #expect(
            DailyUXCreationContext.environmentPreferences(
                for: passiveProject,
                in: snapshot
            ) == FeatureEnvironmentPreferences(
                defaultWorkspaceMode: .worktree,
                newWorktreesStartFromOrigin: false
            )
        )
    }

    @Test
    func explicitEmptyProviderCatalogDoesNotRestoreAStaleProjectDefault() {
        let project = FeatureProject(
            id: "remote-project",
            environmentID: "remote",
            name: "Remote",
            path: "/remote",
            defaultSelection: .init(providerID: "claude", modelID: "old-model")
        )
        let snapshot = FeatureSnapshot(
            environments: [
                .init(
                    id: "remote",
                    name: "Remote",
                    endpoint: "https://remote.example",
                    isActive: false,
                    connectionState: .connected
                ),
            ],
            projects: [project],
            providers: [],
            providersByEnvironment: ["remote": []]
        )

        #expect(DailyUXCreationContext.providers(for: project, in: snapshot).isEmpty)
    }

    @Test
    func projectGroupsOnlyOfferComputersThatContainTheSelectedRepository() throws {
        let identity = FeatureRepositoryIdentity(
            canonicalKey: "github.com/t3/example",
            displayName: "Example"
        )
        let studio = FeatureProject(
            id: "example-studio",
            environmentID: "studio",
            name: "example",
            path: "/code/example",
            repositoryIdentity: identity
        )
        let laptop = FeatureProject(
            id: "example-laptop",
            environmentID: "laptop",
            name: "example-copy",
            path: "/Users/test/example",
            repositoryIdentity: identity
        )
        let unrelated = FeatureProject(
            id: "other-laptop",
            environmentID: "laptop",
            name: "other",
            path: "/Users/test/other",
            repositoryIdentity: .init(canonicalKey: "github.com/t3/other")
        )

        let groups = DailyUXProjectGrouping.groups(projects: [studio, unrelated, laptop])
        let group = try #require(
            DailyUXProjectGrouping.group(containing: studio.id, in: groups)
        )

        #expect(group.name == "Example")
        #expect(Set(group.projects.map(\.environmentID)) == ["studio", "laptop"])
        #expect(group.project(in: "laptop")?.id == laptop.id)
        #expect(!group.memberProjectIDs.contains(unrelated.id))
        #expect(DailyUXProjectGrouping.logicalProjectID(for: studio) == group.id)
    }

    @Test
    func projectSelectionResolvesAgainstCurrentGroups() throws {
        let identity = FeatureRepositoryIdentity(
            canonicalKey: "github.com/t3/example",
            displayName: "Example"
        )
        let staleStudio = FeatureProject(
            id: "stale-studio",
            environmentID: "studio",
            name: "example",
            path: "/code/example",
            repositoryIdentity: identity
        )
        let currentStudio = FeatureProject(
            id: "current-studio",
            environmentID: "studio",
            name: "example",
            path: "/code/example",
            repositoryIdentity: identity
        )
        let laptop = FeatureProject(
            id: "current-laptop",
            environmentID: "laptop",
            name: "example",
            path: "/Users/test/example",
            repositoryIdentity: identity
        )
        let staleGroup = try #require(
            DailyUXProjectGrouping.groups(projects: [staleStudio]).first
        )
        let currentGroups = DailyUXProjectGrouping.groups(
            projects: [currentStudio, laptop]
        )

        #expect(
            DailyUXProjectGrouping.selectionTarget(
                groupID: staleGroup.id,
                preferredEnvironmentID: laptop.environmentID,
                in: currentGroups
            )?.id == laptop.id
        )
        #expect(
            DailyUXProjectGrouping.selectionTarget(
                groupID: "removed-project",
                preferredEnvironmentID: nil,
                in: currentGroups
            ) == nil
        )
    }

    @Test
    func projectsWithoutRepositoryIdentityNeverGroupAcrossComputers() {
        let studio = FeatureProject(
            id: "studio",
            environmentID: "studio",
            name: "Same name",
            path: "/code/project"
        )
        let laptop = FeatureProject(
            id: "laptop",
            environmentID: "laptop",
            name: "Same name",
            path: "/code/project"
        )

        let groups = DailyUXProjectGrouping.groups(projects: [studio, laptop])

        #expect(groups.count == 2)
        #expect(groups.allSatisfy { $0.projects.count == 1 })
    }

    @Test
    func projectGroupingUsesFreshestPhysicalRowAndNormalizesTrailingSlash() throws {
        let identity = FeatureRepositoryIdentity(canonicalKey: "github.com/t3/example")
        let stale = FeatureProject(
            id: "stale",
            environmentID: "studio",
            name: "stale",
            path: "/code/example/",
            repositoryIdentity: nil,
            updatedAt: "2026-01-01T00:00:00.000Z"
        )
        let current = FeatureProject(
            id: "current",
            environmentID: "studio",
            name: "current",
            path: "/code/example",
            repositoryIdentity: identity,
            updatedAt: "2026-01-02T00:00:00.000Z"
        )
        let remote = FeatureProject(
            id: "remote",
            environmentID: "remote",
            name: "remote",
            path: "/srv/example",
            repositoryIdentity: identity
        )

        let groups = DailyUXProjectGrouping.groups(projects: [stale, current, remote])
        let group = try #require(
            DailyUXProjectGrouping.group(containing: stale.id, in: groups)
        )

        #expect(group.projects.map(\.id) == ["remote", "current"])
        #expect(group.memberProjectIDs == ["stale", "current", "remote"])

        let snapshot = rankedSnapshot(
            projects: [stale, current, remote],
            threads: [rankedThread("recent", projectID: stale.id, activity: 20)]
        )
        #expect(
            DailyUXCreationContext.recentProjects(in: snapshot).first?.project.id
                == current.id
        )
        #expect(
            DailyUXCreationContext.initialProject(
                in: snapshot,
                requestedProjectID: stale.id
            )?.id == current.id
        )
    }

    @Test
    func logicalProjectDraftKeyDoesNotChangeWithComputer() {
        let projectKey = "github.com/t3/example"

        #expect(
            FeatureComposerDraftStore.newTaskKey(logicalProjectID: projectKey)
                == "logical-project:github.com/t3/example:new-task"
        )
    }

    @Test
    func projectGroupingHonorsRepositoryPathAndSeparateModes() {
        let identity = FeatureRepositoryIdentity(
            canonicalKey: "github.com/t3/mono",
            rootPath: "/code/mono"
        )
        let app = FeatureProject(
            id: "app",
            environmentID: "studio",
            name: "app",
            path: "/code/mono/apps/app",
            repositoryIdentity: identity
        )
        let docs = FeatureProject(
            id: "docs",
            environmentID: "studio",
            name: "docs",
            path: "/code/mono/apps/docs",
            repositoryIdentity: identity
        )

        #expect(DailyUXProjectGrouping.groups(projects: [app, docs]).count == 1)
        #expect(
            DailyUXProjectGrouping.groups(
                projects: [app, docs],
                mode: .repositoryPath
            ).count == 2
        )
        #expect(
            DailyUXProjectGrouping.groups(
                projects: [app, docs],
                mode: .separate
            ).count == 2
        )
    }

    @Test
    func projectDefaultWinsAndExplicitModelCarriesAcrossCompatibleProjects() throws {
        let appDefault = FeatureSelection(providerID: "codex", modelID: "gpt-5.6-sol")
        let explicit = FeatureSelection(providerID: "codex", modelID: "gpt-5.6-luna")
        let project = FeatureProject(
            id: "project",
            environmentID: "studio",
            name: "Project",
            path: "/project",
            defaultSelection: .init(providerID: "codex", modelID: "gpt-5.6-terra")
        )
        let snapshot = FeatureSnapshot(
            projects: [project],
            providers: [
                .init(
                    id: "codex",
                    name: "Codex",
                    models: [
                        .init(id: "gpt-5.6-luna", name: "Luna"),
                        .init(id: "gpt-5.6-terra", name: "Terra"),
                        .init(id: "gpt-5.6-sol", name: "Sol"),
                    ]
                ),
            ],
            providersByEnvironment: [
                "studio": [
                    .init(
                        id: "codex",
                        name: "Codex",
                        models: [
                            .init(id: "gpt-5.6-luna", name: "Luna"),
                            .init(id: "gpt-5.6-terra", name: "Terra"),
                            .init(id: "gpt-5.6-sol", name: "Sol"),
                        ]
                    ),
                ],
            ],
            settings: .init(defaultSelection: appDefault)
        )

        #expect(
            DailyUXCreationContext.initialSelection(for: project, in: snapshot)
                == FeatureSelection(providerID: "codex", modelID: "gpt-5.6-terra")
        )
        #expect(
            DailyUXCreationContext.selection(
                carrying: explicit,
                to: project,
                in: snapshot
            ) == explicit
        )
    }

    @Test @MainActor
    func imageProcessorDownsamplesUploadAndBuildsSmallThumbnail() throws {
        let source = UIGraphicsImageRenderer(size: CGSize(width: 2_400, height: 1_200))
            .image { context in
                UIColor.systemPink.setFill()
                context.fill(CGRect(x: 0, y: 0, width: 2_400, height: 1_200))
            }
        let sourceData = try #require(source.pngData())

        let attachment = try FeatureImageProcessor.attachment(
            from: sourceData,
            ordinal: 1
        )
        let prepared = try #require(UIImage(data: attachment.data))
        let thumbnail = try #require(
            attachment.thumbnailData.flatMap(UIImage.init(data:))
        )

        #expect(max(prepared.size.width, prepared.size.height) <= 2_048)
        #expect(max(thumbnail.size.width, thumbnail.size.height) <= 160)
        #expect(attachment.mimeType == "image/jpeg")
    }

    private func rankedProject(
        _ id: String,
        name: String,
        environmentID: String = "environment",
        repositoryKey: String? = nil
    ) -> FeatureProject {
        FeatureProject(
            id: id,
            environmentID: environmentID,
            name: name,
            path: "/\(id)",
            repositoryIdentity: repositoryKey.map {
                FeatureRepositoryIdentity(canonicalKey: $0)
            }
        )
    }

    private func rankedThread(
        _ id: String,
        projectID: String,
        environmentID: String? = nil,
        activity: TimeInterval? = nil,
        updatedAt: TimeInterval? = nil,
        lastActivityAt: TimeInterval? = nil,
        isArchived: Bool = false,
        isSettled: Bool = false
    ) -> FeatureThread {
        let updatedAt = updatedAt ?? activity ?? 0
        return FeatureThread(
            id: id,
            projectID: projectID,
            environmentID: environmentID,
            title: id,
            updatedAt: Date(timeIntervalSince1970: updatedAt),
            isArchived: isArchived,
            isSettled: isSettled,
            lastActivityAt: lastActivityAt.map(Date.init(timeIntervalSince1970:))
        )
    }

    private func rankedSnapshot(
        environments: [FeatureEnvironment] = [],
        projects: [FeatureProject],
        threads: [FeatureThread]
    ) -> FeatureSnapshot {
        FeatureSnapshot(environments: environments, projects: projects, threads: threads)
    }
}
