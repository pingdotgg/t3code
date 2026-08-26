import XCTest
@testable import T3Code

final class ThreadCopyActionsTests: XCTestCase {
    func testActionsMatchElectronOrderAndCopyExactRawValues() {
        let thread = FeatureThread(
            id: "scoped-thread-id",
            wireID: " thread-1 ",
            projectID: "project-1",
            title: "Copy values",
            branch: " feature/copy-values ",
            worktreePath: " /worktrees/copy-values "
        )

        let actions = ThreadCopyModel.actions(
            for: thread,
            context: context(projectWorkspaceRoot: "/work/t3code")
        )
        XCTAssertEqual(
            actions,
            [
                ThreadCopyAction(kind: .path, value: " /worktrees/copy-values "),
                ThreadCopyAction(kind: .branch, value: " feature/copy-values "),
                ThreadCopyAction(kind: .threadID, value: " thread-1 "),
            ]
        )
        XCTAssertTrue(actions.allSatisfy(\.isAvailable))
    }

    func testPathFallsBackToProjectWorkspaceRoot() {
        let thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            title: "Local checkout"
        )

        XCTAssertEqual(
            ThreadCopyModel.actions(
                for: thread,
                context: context(projectWorkspaceRoot: "/work/t3code")
            ),
            [
                ThreadCopyAction(kind: .path, value: "/work/t3code"),
                ThreadCopyAction(kind: .threadID, value: "thread-1"),
            ]
        )
    }

    func testBlankWorktreePathFallsBackToProjectWorkspaceRoot() {
        let thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            title: "Local checkout",
            worktreePath: "  "
        )

        XCTAssertEqual(
            ThreadCopyModel.actions(
                for: thread,
                context: context(projectWorkspaceRoot: "/work/t3code")
            ).first,
            ThreadCopyAction(kind: .path, value: "/work/t3code")
        )
    }

    func testUnavailablePathRemainsVisibleAndBlankBranchIsOmitted() {
        let thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            title: "No path",
            branch: " \n "
        )

        let actions = ThreadCopyModel.actions(for: thread, context: context())
        XCTAssertEqual(
            actions,
            [
                ThreadCopyAction(kind: .path, value: nil),
                ThreadCopyAction(kind: .threadID, value: "thread-1"),
            ]
        )
        XCTAssertFalse(actions[0].isAvailable)
        XCTAssertTrue(actions[1].isAvailable)
    }

    func testWorktreePathTakesPrecedenceOverProjectWorkspaceRoot() {
        let thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            title: "Worktree",
            worktreePath: "/worktrees/feature"
        )

        XCTAssertEqual(
            ThreadCopyModel.actions(
                for: thread,
                context: context(projectWorkspaceRoot: "/work/t3code")
            ).first,
            ThreadCopyAction(kind: .path, value: "/worktrees/feature")
        )
    }

    func testThreadIDUsesWireIdentityThenFallsBackToLocalIdentity() {
        let wireThread = FeatureThread(
            id: "scoped-thread-id",
            wireID: "wire-thread-id",
            projectID: "project-1",
            title: "Wire identity"
        )
        let localThread = FeatureThread(
            id: "scoped-thread-id",
            wireID: "  ",
            projectID: "project-1",
            title: "Local identity"
        )

        XCTAssertEqual(
            ThreadCopyModel.actions(for: wireThread, context: context()).last,
            ThreadCopyAction(kind: .threadID, value: "wire-thread-id")
        )
        XCTAssertEqual(
            ThreadCopyModel.actions(for: localThread, context: context()).last,
            ThreadCopyAction(kind: .threadID, value: "scoped-thread-id")
        )
    }

    func testActionLabelsAndAnnouncementsAreDistinct() {
        XCTAssertEqual(ThreadCopyActionKind.path.title, "Path")
        XCTAssertEqual(ThreadCopyActionKind.path.copyAnnouncement, "Path copied")
        XCTAssertEqual(ThreadCopyActionKind.branch.title, "Branch")
        XCTAssertEqual(ThreadCopyActionKind.branch.copyAnnouncement, "Branch copied")
        XCTAssertEqual(ThreadCopyActionKind.threadID.title, "Thread ID")
        XCTAssertEqual(ThreadCopyActionKind.threadID.copyAnnouncement, "Thread ID copied")
        XCTAssertEqual(ThreadCopyActionKind.project.title, "Project")
        XCTAssertEqual(ThreadCopyActionKind.project.copyAnnouncement, "Project copied")
        XCTAssertEqual(ThreadCopyActionKind.environment.title, "Environment")
        XCTAssertEqual(ThreadCopyActionKind.environment.copyAnnouncement, "Environment copied")
        XCTAssertEqual(ThreadCopyActionKind.url.title, "URL")
        XCTAssertEqual(ThreadCopyActionKind.url.copyAnnouncement, "URL copied")
        XCTAssertEqual(
            ThreadCopyAction(kind: .path, value: nil).announcement,
            "Path unavailable"
        )
        XCTAssertEqual(
            ThreadCopyAction(kind: .path, value: "/work/t3code").announcement,
            "Path copied"
        )
    }

    func testAvailableMetadataProducesOnlyIndividualActionsAndValues() {
        let thread = FeatureThread(
            id: "scoped-thread-id",
            wireID: "thread-1",
            projectID: "project-1",
            environmentID: "environment-1",
            title: "Copy values",
            branch: "feature/copy-values",
            worktreePath: "/worktrees/copy-values"
        )

        let actions = ThreadCopyModel.actions(
            for: thread,
            context: context(
                projectName: "pingdotgg/t3code",
                projectWorkspaceRoot: "/work/t3code",
                environmentName: "Studio Mac",
                environmentID: "fallback-environment"
            )
        )

        XCTAssertEqual(
            actions,
            [
                ThreadCopyAction(kind: .path, value: "/worktrees/copy-values"),
                ThreadCopyAction(kind: .branch, value: "feature/copy-values"),
                ThreadCopyAction(kind: .threadID, value: "thread-1"),
                ThreadCopyAction(kind: .project, value: "pingdotgg/t3code"),
                ThreadCopyAction(kind: .environment, value: "Studio Mac"),
                ThreadCopyAction(
                    kind: .url,
                    value: "https://app.t3.codes/environment-1/thread-1"
                ),
            ]
        )
        XCTAssertTrue(actions.allSatisfy { action in
            action.value?.contains("\n") == false
        })
    }

    func testUnavailableMetadataDoesNotProduceIndividualActions() {
        let thread = FeatureThread(
            id: "thread-1",
            wireID: nil,
            projectID: "project-1",
            environmentID: nil,
            title: "Sparse values"
        )

        let actions = ThreadCopyModel.actions(for: thread, context: context())

        XCTAssertEqual(
            actions.map(\.kind),
            [.path, .threadID]
        )
        XCTAssertFalse(actions.contains { action in
            [.project, .environment, .url].contains(action.kind)
        })
    }

    func testURLPercentEncodesRouteValuesAsSinglePathSegments() {
        let thread = FeatureThread(
            id: "scoped-thread-id",
            wireID: "thread/one",
            projectID: "project-1",
            environmentID: "studio one",
            title: "Encoded route"
        )

        let url = ThreadCopyModel.actions(for: thread, context: context())
            .first { $0.kind == .url }

        XCTAssertEqual(
            url?.value,
            "https://app.t3.codes/studio%20one/thread%2Fone"
        )
    }

    private func context(
        projectName: String? = nil,
        projectWorkspaceRoot: String? = nil,
        environmentName: String? = nil,
        environmentID: String? = nil
    ) -> ThreadCopyContext {
        ThreadCopyContext(
            projectName: projectName,
            projectWorkspaceRoot: projectWorkspaceRoot,
            environmentName: environmentName,
            environmentID: environmentID
        )
    }
}
