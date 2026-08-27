import Foundation
import Testing
@testable import T3Code

@Suite("Command drawer presentation and integration")
struct FeatureCommandDrawerPresentationTests {
    @Test
    func catalogOffersWorkspaceActionsThenRecentThreadsAndProjects() {
        let items = FeatureCommandDrawerCatalog.items(
            projects: [project("alpha", name: "Alpha")],
            threads: [
                thread("old", projectID: "alpha", title: "Older task", activity: 10),
                thread("new", projectID: "alpha", title: "Newer task", activity: 20),
            ],
            selectedProjectID: nil,
            query: ""
        )

        #expect(
            items.map(\.id) == [
                "action:newTask",
                "action:addProject",
                "action:settings",
                "thread:new",
                "thread:old",
                "project:alpha",
            ]
        )
    }

    @Test
    func clearingTheProjectFilterIsOfferedOnlyWhileAFilterIsApplied() {
        let projects = [project("alpha", name: "Alpha")]

        #expect(
            FeatureCommandDrawerCatalog.items(
                projects: projects,
                threads: [],
                selectedProjectID: "alpha",
                query: ""
            ).first?.id == "action:allProjects"
        )
        #expect(
            FeatureCommandDrawerCatalog.items(
                projects: projects,
                threads: [],
                selectedProjectID: nil,
                query: ""
            ).contains { $0.id == "action:allProjects" } == false
        )
    }

    @Test
    func queryFiltersActionsThreadsAndProjectsTogether() {
        let items = FeatureCommandDrawerCatalog.items(
            projects: [project("alpha", name: "Alpha"), project("beta", name: "Beta")],
            threads: [
                thread("a", projectID: "alpha", title: "Ship the alpha drawer", activity: 30),
                thread("b", projectID: "beta", title: "Unrelated", activity: 40),
            ],
            selectedProjectID: nil,
            query: "  ALPHA "
        )

        #expect(items.map(\.id) == ["thread:a", "project:alpha"])
    }

    @Test
    func archivedThreadsStayOutAndCatalogResultsAreBounded() {
        let threads = (0..<20).map {
            thread("t\($0)", projectID: "alpha", title: "Task \($0)", activity: TimeInterval($0))
        } + [
            thread(
                "gone",
                projectID: "alpha",
                title: "Task archived",
                activity: 999,
                isArchived: true
            ),
        ]

        let items = FeatureCommandDrawerCatalog.items(
            projects: (0..<10).map { project("p\($0)", name: "Project \($0)") },
            threads: threads,
            selectedProjectID: nil,
            query: ""
        )

        let threadIDs = items.compactMap { item -> String? in
            guard case let .thread(id, _, _) = item else { return nil }
            return id
        }
        let projectIDs = items.compactMap { item -> String? in
            guard case let .project(id, _) = item else { return nil }
            return id
        }
        #expect(threadIDs.count == FeatureCommandDrawerCatalog.threadLimit)
        #expect(threadIDs.first == "t19")
        #expect(threadIDs.contains("gone") == false)
        #expect(projectIDs.count == FeatureCommandDrawerCatalog.projectLimit)
    }

    @Test
    func threadRowsCarryTheirProjectNameForDisambiguation() {
        let items = FeatureCommandDrawerCatalog.items(
            projects: [project("alpha", name: "Alpha")],
            threads: [
                thread("known", projectID: "alpha", title: "Known", activity: 20),
                thread("orphan", projectID: "missing", title: "Orphan", activity: 10),
            ],
            selectedProjectID: nil,
            query: "n"
        )

        #expect(
            items.contains { $0 == .thread(id: "known", title: "Known", projectName: "Alpha") }
        )
        #expect(
            items.contains { $0 == .thread(id: "orphan", title: "Orphan", projectName: nil) }
        )
    }

    @Test
    func everyItemMapsToTheTypedWorkspaceDestinationItOwns() {
        #expect(
            FeatureCommandDrawerItem.thread(
                id: "thread-1",
                title: "Thread",
                projectName: "Project"
            ).destination == .thread(id: "thread-1")
        )
        #expect(
            FeatureCommandDrawerItem.project(id: "project-1", name: "Project").destination
                == .project(id: "project-1")
        )
        for action in FeatureCommandDrawerAction.allCases {
            #expect(FeatureCommandDrawerItem.action(action).destination == .action(action))
        }
    }

    @Test
    func presentationMetadataNamesEveryRowWithoutLosingContext() {
        let thread = FeatureCommandDrawerItem.thread(
            id: "thread-1",
            title: "Fix focus",
            projectName: "T3 Code"
        )
        let project = FeatureCommandDrawerItem.project(id: "project-1", name: "T3 Code")

        #expect(thread.title == "Fix focus")
        #expect(thread.subtitle == "T3 Code")
        #expect(thread.systemImage == "bubble.left.and.text.bubble.right")
        #expect(project.title == "T3 Code")
        #expect(project.subtitle == "Filter Home to this project")
        #expect(project.systemImage == "folder")
        for action in FeatureCommandDrawerAction.allCases {
            let item = FeatureCommandDrawerItem.action(action)
            #expect(item.title.isEmpty == false)
            #expect(item.systemImage.isEmpty == false)
            #expect(item.subtitle == nil)
        }
    }

    @Test
    func accessibilityExposureIsStableUniqueAndOnlyVisibleAtTheOpenRestState() {
        let items: [FeatureCommandDrawerItem] = [
            .action(.settings),
            .project(id: "project-1", name: "T3 Code"),
            .thread(id: "thread-1", title: "Fix focus", projectName: "T3 Code"),
        ]
        let identifiers = items.map(FeatureCommandDrawerAccessibility.itemIdentifier)

        #expect(Set(identifiers).count == items.count)
        #expect(identifiers == [
            "command-drawer-item-action:settings",
            "command-drawer-item-project:project-1",
            "command-drawer-item-thread:thread-1",
        ])
        #expect(FeatureCommandDrawerAccessibility.searchLabel == "Search commands")
        #expect(FeatureCommandDrawerAccessibility.scrimLabel == "Close commands")

        var state = FeatureCommandDrawerState()
        #expect(FeatureCommandDrawerAccessibility.drawerIsHidden(state))
        #expect(FeatureCommandDrawerAccessibility.scrimIsHidden(state))
        #expect(FeatureCommandDrawerAccessibility.workspaceIsHidden(state) == false)
        state.beginDrag()
        state.updateDrag(translation: 100, openHeight: 500)
        #expect(FeatureCommandDrawerAccessibility.drawerIsHidden(state))
        #expect(FeatureCommandDrawerAccessibility.scrimIsHidden(state))
        #expect(FeatureCommandDrawerAccessibility.workspaceIsHidden(state) == false)
        state.settle(open: true, openHeight: 500)
        #expect(FeatureCommandDrawerAccessibility.drawerIsHidden(state) == false)
        #expect(FeatureCommandDrawerAccessibility.scrimIsHidden(state) == false)
        #expect(FeatureCommandDrawerAccessibility.workspaceIsHidden(state))
        state.close()
        #expect(FeatureCommandDrawerAccessibility.drawerIsHidden(state))
        #expect(FeatureCommandDrawerAccessibility.scrimIsHidden(state))
        #expect(FeatureCommandDrawerAccessibility.workspaceIsHidden(state) == false)
    }

    @Test
    func settledPresentationTracksKeyboardResizesWithoutBreakingFingerBoundDrags() {
        var state = FeatureCommandDrawerState()
        state.settle(open: true, openHeight: 480)

        #expect(
            FeatureCommandDrawerPresentationGeometry.reveal(
                state: state,
                measuredOpenHeight: 720
            ) == 720
        )

        state.beginDrag()
        state.updateDrag(translation: -40, openHeight: 720)
        #expect(
            FeatureCommandDrawerPresentationGeometry.reveal(
                state: state,
                measuredOpenHeight: 720
            ) == 440
        )

        state.close()
        #expect(
            FeatureCommandDrawerPresentationGeometry.reveal(
                state: state,
                measuredOpenHeight: 720
            ) == 0
        )
    }

    private func project(_ id: String, name: String) -> FeatureProject {
        FeatureProject(id: id, environmentID: "env", name: name, path: "/tmp/\(id)")
    }

    private func thread(
        _ id: String,
        projectID: String,
        title: String,
        activity: TimeInterval,
        isArchived: Bool = false
    ) -> FeatureThread {
        FeatureThread(
            id: id,
            projectID: projectID,
            title: title,
            updatedAt: Date(timeIntervalSince1970: activity),
            isArchived: isArchived,
            lastActivityAt: Date(timeIntervalSince1970: activity)
        )
    }
}
