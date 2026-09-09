import Foundation
import Testing
@testable import T3Code

struct WorkspaceThreadPresentationTests {
    @Test(arguments: [false, true], [false, true])
    func presentationTracksCompactColumnWithoutHidingRegularDetail(isCompact: Bool, showsDetail: Bool) {
        var selection = WorkspaceThreadSelection()
        selection.open("a")
        let isHidden = isCompact && !showsDetail
        #expect(selection.presentedID(isCompact: isCompact, showsDetailColumn: showsDetail) == (isHidden ? nil : "a"))
        selection.reconcilePresentation(isCompact: isCompact, showsDetailColumn: showsDetail)
        #expect(selection.selectedID == (isHidden ? nil : "a"))
        #expect(selection.highlightedID == "a")
    }

    @Test
    func compactBackAndRegularToCompactHideCannotResurrectClosedThread() {
        var selection = WorkspaceThreadSelection()
        selection.open("a")
        selection.reconcilePresentation(isCompact: false, showsDetailColumn: false)
        #expect(selection.selectedID == "a")
        selection.reconcilePresentation(isCompact: true, showsDetailColumn: false)
        #expect(selection.selectedID == nil)
        selection.reconcilePresentation(isCompact: false, showsDetailColumn: false)
        #expect(selection.presentedID(isCompact: false, showsDetailColumn: false) == nil)
        #expect(selection.highlightedID == "a")
        selection.open("a")
        #expect(selection.presentedID(isCompact: true, showsDetailColumn: true) == "a")
        selection.close()
        #expect(selection.presentedID(isCompact: true, showsDetailColumn: true) == nil)
    }
}
