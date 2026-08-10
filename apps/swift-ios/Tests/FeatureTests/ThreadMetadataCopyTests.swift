import Testing
@testable import T3Code

@Suite("Thread metadata copy")
struct ThreadMetadataCopyTests {
    @Test
    func offersWorktreePathBranchAndWireIDInMenuOrder() {
        let thread = FeatureThread(
            id: "environment:one:thread:thread-1",
            wireID: "thread-1",
            projectID: "project-1",
            title: "Metadata",
            branch: " feature/copy ",
            worktreePath: " /tmp/copy-worktree "
        )

        let items = ThreadMetadataCopyModel.items(
            for: thread,
            projectPath: "/tmp/project"
        )

        #expect(items.map(\.kind) == [.path, .branch, .threadID])
        #expect(items.map(\.value) == [" /tmp/copy-worktree ", "feature/copy", "thread-1"])
        #expect(items.map(\.title) == ["Copy path", "Copy branch", "Copy thread ID"])
        #expect(items.map(\.confirmation) == ["Path copied", "Branch copied", "Thread ID copied"])
    }

    @Test
    func fallsBackToProjectPathAndInternalThreadID() {
        let thread = FeatureThread(
            id: "environment:one:thread:thread-1",
            wireID: "  ",
            projectID: "project-1",
            title: "Fallback"
        )

        let items = ThreadMetadataCopyModel.items(
            for: thread,
            projectPath: "/tmp/project"
        )

        #expect(items.map(\.kind) == [.path, .threadID])
        #expect(items.map(\.value) == ["/tmp/project", "environment:one:thread:thread-1"])
    }

    @Test
    func unavailableValuesDoNotCreateDeadMenuActions() {
        let thread = FeatureThread(
            id: "  ",
            wireID: nil,
            projectID: "project-1",
            title: "Unavailable",
            branch: "\n",
            worktreePath: nil
        )

        #expect(ThreadMetadataCopyModel.items(for: thread, projectPath: "  ").isEmpty)
    }

    @Test
    func eachMenuRequestUsesTheCurrentRowMetadata() {
        let first = FeatureThread(
            id: "first",
            wireID: "wire-first",
            projectID: "project-1",
            title: "First",
            branch: "feature/first",
            worktreePath: "/tmp/first"
        )
        let reused = FeatureThread(
            id: "second",
            wireID: "wire-second",
            projectID: "project-2",
            title: "Second",
            branch: "feature/second",
            worktreePath: "/tmp/second"
        )

        let firstItems = ThreadMetadataCopyModel.items(for: first, projectPath: nil)
        let reusedItems = ThreadMetadataCopyModel.items(for: reused, projectPath: nil)

        #expect(firstItems.map(\.value) == ["/tmp/first", "feature/first", "wire-first"])
        #expect(reusedItems.map(\.value) == ["/tmp/second", "feature/second", "wire-second"])
    }
}
