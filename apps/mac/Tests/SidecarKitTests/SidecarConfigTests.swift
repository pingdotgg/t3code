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

    @Test("bundled entry path resolves SergeCodeServer/bin.mjs under the bundle resources")
    func bundledEntryPath() throws {
        let resourceDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("sergecode-entry-resolver-\(UUID().uuidString)")
        let serverDir = resourceDir.appendingPathComponent("SergeCodeServer")
        try FileManager.default.createDirectory(at: serverDir, withIntermediateDirectories: true)
        let entry = serverDir.appendingPathComponent("bin.mjs")
        guard FileManager.default.createFile(atPath: entry.path, contents: Data()) else {
            throw NSError(domain: "SidecarConfigTests", code: 1)
        }
        defer { try? FileManager.default.removeItem(at: resourceDir) }

        let resolved = SidecarEntryPathResolver.bundledEntryPath(resourceURL: resourceDir)
        #expect(resolved == entry.path)
    }

    @Test("bundled entry path is nil when the bundle embeds no server")
    func bundledEntryPathMissing() throws {
        let resourceDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("sergecode-entry-resolver-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: resourceDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: resourceDir) }

        #expect(SidecarEntryPathResolver.bundledEntryPath(resourceURL: resourceDir) == nil)
        #expect(SidecarEntryPathResolver.bundledEntryPath(resourceURL: nil) == nil)
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

    @Test("tailscale serve defaults off and is carried through when enabled")
    func tailscaleServePassThrough() throws {
        let defaulted = try SidecarConfig(
            nodePath: "/usr/local/bin/node", port: 54321, baseDir: "/tmp/sergecode-test")
        #expect(defaulted.tailscaleServeEnabled == false)
        #expect(defaulted.tailscaleServePort == 443)

        let enabled = try SidecarConfig(
            nodePath: "/usr/local/bin/node", port: 54321, baseDir: "/tmp/sergecode-test",
            tailscaleServeEnabled: true, tailscaleServePort: 8443)
        #expect(enabled.tailscaleServeEnabled == true)
        #expect(enabled.tailscaleServePort == 8443)
    }
}
