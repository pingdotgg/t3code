import XCTest
@testable import T3Code

@MainActor
final class ProjectDefaultsTests: XCTestCase {
    func testSelectedProjectUsesItsEnvironmentAndKeepsExplicitModelChoice() {
        let projectDefault = FeatureSelection(providerID: "remote-provider", modelID: "project")
        let explicit = FeatureSelection(providerID: "remote-provider", modelID: "chosen")
        var project = FeatureProject(
            id: "remote-project", environmentID: "remote", name: "Project", path: "/project",
            defaultSelection: projectDefault
        )
        project.defaultWorkspaceMode = .local
        project.newWorktreesStartFromOrigin = false
        let snapshot = FeatureSnapshot(
            projects: [project],
            providers: [.init(id: "local-provider", name: "Local", models: [.init(id: "local", name: "Local")])],
            providersByEnvironment: ["remote": [
                .init(id: "remote-provider", name: "Remote", models: [
                    .init(id: "project", name: "Project"), .init(id: "chosen", name: "Chosen"),
                ]),
            ]],
            preferencesByEnvironment: ["remote": .init(
                defaultWorkspaceMode: .worktree, newWorktreesStartFromOrigin: true,
                supportsImageUploads: true, maxFileAttachmentBytes: 512
            )]
        )
        let preferences = DailyUXCreationContext.environmentPreferences(for: project, in: snapshot)
        XCTAssertEqual(preferences.defaultWorkspaceMode, .local)
        XCTAssertFalse(preferences.newWorktreesStartFromOrigin)
        XCTAssertTrue(preferences.supportsImageUploads)
        XCTAssertEqual(preferences.maxFileAttachmentBytes, 512)
        XCTAssertEqual(DailyUXCreationContext.selection(carrying: nil, to: project, in: snapshot), projectDefault)
        XCTAssertEqual(DailyUXCreationContext.selection(carrying: explicit, to: project, in: snapshot), explicit)
        XCTAssertEqual(DailyUXCreationContext.selection(
            carrying: .init(providerID: "local-provider", modelID: "local"), to: project, in: snapshot
        ), projectDefault)
    }

    func testProjectSettingsChangesInvalidateCachedDefaultsWithoutShellChanges() {
        var projection = NativeShellProjection()
        let projects = multiEnvironmentShell(projectID: "project", threadID: "thread", title: "Task").projects
        var settings = ServerSettingsSnapshot()
        var mappedCount = 0
        let map: (OrchestrationProject) -> FeatureProject = { project in
            mappedCount += 1
            return FeatureProject(id: project.id, environmentID: "one", name: project.title, path: project.workspaceRoot)
        }
        _ = projection.mapProjects(projects, settings: settings, transform: map)
        _ = projection.mapProjects(projects, settings: settings, transform: map)
        XCTAssertEqual(mappedCount, 1)
        settings.projectSettingsOverrides = ["project": ["defaultThreadEnvMode": .string("worktree")]]
        _ = projection.mapProjects(projects, settings: settings, transform: map)
        XCTAssertEqual(mappedCount, 2)
        _ = projection.mapProjects(projects, settings: settings,
                                   disabledProviderIDs: ["codex"], transform: map)
        XCTAssertEqual(mappedCount, 3)
    }
}
