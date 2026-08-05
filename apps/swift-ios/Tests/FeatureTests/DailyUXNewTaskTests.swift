import Foundation
import Testing
import UIKit
@testable import T3Code

@Suite("Message-first task creation")
struct DailyUXNewTaskTests {
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
                == ["active-project", "passive-project"]
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
    func appDefaultWinsAndExplicitModelCarriesAcrossCompatibleProjects() throws {
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
            settings: .init(defaultSelection: appDefault)
        )

        #expect(DailyUXCreationContext.initialSelection(for: project, in: snapshot) == appDefault)
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
}
