import Foundation
import Testing
@testable import T3Code

struct NativeLicenseCatalogTests {
    @Test func shippedNoticesCoverNativePackagesAndTerminalDependencies() throws {
        let licenses = try NativeLicenseCatalog.load()
        let names = Set(licenses.map(\.name))
        #expect(names.isSuperset(of: [
            "Clerk", "Nuke", "PhoneNumberKit", "GhosttyKit", "FreeType",
            "libintl", "JetBrains Mono", "Symbols Nerd Font", "simdutf",
        ]))
        #expect(names.count == licenses.count)
        for license in licenses {
            #expect(!license.version.isEmpty)
            #expect(!license.notices.isEmpty)
            for notice in license.notices {
                #expect(notice.sourceURL.scheme == "https")
                #expect(notice.text.count > 100)
            }
        }
    }
}
