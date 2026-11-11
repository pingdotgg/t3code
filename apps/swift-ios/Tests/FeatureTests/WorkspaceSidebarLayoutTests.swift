import SwiftUI
import Testing
@testable import T3Code

@Suite("Workspace sidebar layout")
struct WorkspaceSidebarLayoutTests {
    @Test
    func openThreadIsNeverCoveredByAnOverlaySidebar() {
        let overlay = WorkspaceSidebarLayout(isWideWindow: true, splitTiles: false)
        #expect(!overlay.tilesSidebar)
        #expect(overlay.visibility(hasThread: true, hasTool: false) == .detailOnly)
        #expect(overlay.visibility(hasThread: false, hasTool: false) == .all)
    }

    @Test
    func sidebarStaysBesideThreadOnlyInWideTiledWindows() {
        let wide = WorkspaceSidebarLayout(isWideWindow: true, splitTiles: true)
        #expect(wide.visibility(hasThread: true, hasTool: false) == .all)
        #expect(wide.visibility(hasThread: true, hasTool: true) == .detailOnly)

        let portrait = WorkspaceSidebarLayout(isWideWindow: false, splitTiles: true)
        #expect(portrait.visibility(hasThread: true, hasTool: false) == .detailOnly)
    }
}
