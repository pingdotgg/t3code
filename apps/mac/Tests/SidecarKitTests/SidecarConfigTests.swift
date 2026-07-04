import Foundation
import Testing

@testable import SidecarKit

@Suite("SidecarConfig")
struct SidecarConfigTests {
    @Test("dev default entry path resolves to apps/server/dist/bin.mjs under the repo root")
    func devDefaultEntryPath() {
        // Simulate this source file's real on-disk location so the test
        // doesn't depend on where SidecarKitTests happens to be checked out.
        let fakeSourceFile = "/Users/dev/SergeCode/apps/mac/Sources/SidecarKit/SidecarConfig.swift"
        let entryPath = SidecarEntryPathResolver.devDefaultEntryPath(sourceFile: fakeSourceFile)
        #expect(entryPath == "/Users/dev/SergeCode/apps/server/dist/bin.mjs")
    }

    @Test("default base dir lives under Application Support/SergeCode")
    func defaultBaseDir() {
        let baseDir = SidecarConfig.defaultBaseDir()
        #expect(baseDir.hasSuffix("/Application Support/SergeCode"))
    }

    @Test("an explicit port is honored without probing for a free one")
    func explicitPortIsHonored() throws {
        let config = try SidecarConfig(nodePath: "/usr/local/bin/node", port: 54321, baseDir: "/tmp/sergecode-test")
        #expect(config.port == 54321)
        #expect(config.logDirectory == "/tmp/sergecode-test/logs/sidecar")
    }
}
