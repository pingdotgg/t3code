import Testing
@testable import T3Code

@Suite("Related thread navigation")
struct WorkspaceThreadSelectionTests {
    @Test
    func relatedThreadBackReturnsThroughParentAndGrandparent() {
        var selection = WorkspaceThreadSelection()
        selection.open("parent")
        selection.push("child")
        selection.push("grandchild")
        #expect(selection.rootID == "parent")
        #expect(selection.navigationPath == ["child", "grandchild"])

        selection.back(availableIDs: ["parent", "child", "grandchild"])
        #expect(selection.selectedID == "child")
        selection.back(availableIDs: ["parent", "child", "grandchild"])
        #expect(selection.selectedID == "parent")
        #expect(selection.navigationPath.isEmpty)
        selection.back(availableIDs: ["parent", "child", "grandchild"])
        #expect(selection.selectedID == nil)
        #expect(selection.highlightedID == "parent")
    }

    @Test
    func nativeBackAndSwipePopTheBoundPath() {
        var selection = WorkspaceThreadSelection()
        selection.open("parent")
        selection.push("child")
        selection.push("grandchild")
        selection.pop(to: ["child"], availableIDs: ["parent", "child", "grandchild"])
        #expect(selection.selectedID == "child")
        #expect(selection.history == ["parent"])
        selection.pop(to: [], availableIDs: ["parent", "child", "grandchild"])
        #expect(selection.selectedID == "parent")
        #expect(selection.history.isEmpty)
        selection.pop(to: [], availableIDs: ["parent", "child", "grandchild"])
        #expect(selection.selectedID == "parent")
    }

    @Test
    func rootSelectionAndExternalNavigationResetHistory() {
        var selection = WorkspaceThreadSelection()
        selection.open("parent")
        selection.push("child")
        selection.open("external")
        #expect(selection.history.isEmpty)
        selection.back(availableIDs: ["parent", "child", "external"])
        #expect(selection.selectedID == nil)

        selection.open("parent")
        selection.push("child")
        selection.resetHistory()
        #expect(selection.rootID == "child")
        #expect(selection.navigationPath.isEmpty)
    }

    @Test
    func removedParentIsSkippedAndMissingAncestorsReturnToSidebar() {
        var selection = WorkspaceThreadSelection()
        selection.open("parent")
        selection.push("child")
        selection.push("grandchild")
        selection.back(availableIDs: ["parent", "grandchild"])
        #expect(selection.selectedID == "parent")

        selection.push("child")
        selection.back(availableIDs: ["child"])
        #expect(selection.selectedID == nil)
        #expect(selection.history.isEmpty)
    }

    @Test
    func nativePopSkipsRemovedTargetsWithoutReopeningTheCurrentThread() {
        var selection = WorkspaceThreadSelection()
        selection.open("parent")
        selection.push("child")
        selection.push("grandchild")
        selection.pop(to: ["child"], availableIDs: ["parent", "grandchild"])
        #expect(selection.selectedID == "parent")
        selection.push("grandchild")
        selection.pop(to: [], availableIDs: ["grandchild"])
        #expect(selection.selectedID == nil)
    }

    @Test
    func equalWireIDsInDifferentEnvironmentsRemainSeparate() {
        let first = FeatureScopedID.thread(environmentID: "first", wireID: "same")
        let second = FeatureScopedID.thread(environmentID: "second", wireID: "same")
        var selection = WorkspaceThreadSelection()
        selection.open(first)
        selection.push(second)
        #expect(selection.selectedID == second)
        #expect(selection.navigationPath == [second])
        selection.back(availableIDs: [first, second])
        #expect(selection.selectedID == first)
        selection.push(second)
        selection.back(availableIDs: [second])
        #expect(selection.selectedID == nil)
    }

    @Test
    func repeatedLinksDoNotCreateLoopsAndUnrelatedNativePathsAreIgnored() {
        var selection = WorkspaceThreadSelection()
        selection.open("parent")
        selection.push("child")
        selection.push("child")
        #expect(selection.navigationPath == ["child"])
        selection.push("grandchild")
        selection.pop(to: ["unrelated"], availableIDs: ["parent", "child", "grandchild", "unrelated"])
        #expect(selection.selectedID == "grandchild")
        selection.push("parent")
        #expect(selection.selectedID == "parent")
        #expect(selection.navigationPath.isEmpty)
    }
}
