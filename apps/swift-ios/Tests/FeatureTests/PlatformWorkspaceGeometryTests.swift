import Testing
import UIKit
@testable import T3Code

@MainActor
@Suite("Workspace orientation")
struct PlatformWorkspaceGeometryTests {
    @Test
    func hingeRotationPermissionIsKeptPerWindow() {
        let duo = UIWindow()
        let phone = UIWindow()
        duo.traitOverrides.userInterfaceIdiom = .phone
        phone.traitOverrides.userInterfaceIdiom = .phone
        #expect(PlatformWorkspaceOrientation.supportedOrientations(in: duo) == .portrait)
        #expect(PlatformWorkspaceOrientation.supportedOrientations(in: phone) == .portrait)

        PlatformWorkspaceOrientation.allowHingeOrientations(in: duo)
        #expect(PlatformWorkspaceOrientation.supportedOrientations(in: duo) == .allButUpsideDown)
        #expect(PlatformWorkspaceOrientation.supportedOrientations(in: phone) == .portrait)
        #expect(PlatformWorkspaceOrientation.supportedOrientations(in: nil) == .portrait)

        PlatformWorkspaceOrientation.allowHingeOrientations(in: duo)
        #expect(PlatformWorkspaceOrientation.supportedOrientations(in: duo) == .allButUpsideDown)
    }
}
