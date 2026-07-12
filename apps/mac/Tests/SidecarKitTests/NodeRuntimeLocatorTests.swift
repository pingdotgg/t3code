import Foundation
import Testing

@testable import SidecarKit

@Suite("Node runtime locator")
struct NodeRuntimeLocatorTests {
    @Test("a valid cached path skips the login-shell probe and persistence")
    func cachedValidShortCircuits() throws {
        let cachedPath = try makeExecutableNodeFile()
        defer { try? FileManager.default.removeItem(atPath: cachedPath) }

        let recorder = ProbeRecorder()
        let locator = NodeRuntimeLocator(
            environment: [:],
            runVersionProbe: { path in
                recorder.recordVersionProbe(path)
                return "v22.16.0"
            },
            cachedPath: cachedPath,
            onLocated: { path in recorder.recordLocated(path) },
            runLoginShellPathProbe: {
                preconditionFailure("a valid cached path must not probe the login shell")
            }
        )

        let located = try locator.locate()

        #expect(located.path == cachedPath)
        #expect(recorder.versionProbePaths == [cachedPath])
        #expect(recorder.loginShellProbeCount == 0)
        #expect(recorder.locatedPaths.isEmpty)
    }

    @Test("a stale cached path falls through and refreshes the cache")
    func cachedStaleFallsThrough() throws {
        let cachedPath = try makeExecutableNodeFile()
        let fallbackPath = try makeExecutableNodeFile()
        defer {
            try? FileManager.default.removeItem(atPath: cachedPath)
            try? FileManager.default.removeItem(atPath: fallbackPath)
        }

        let recorder = ProbeRecorder()
        let locator = NodeRuntimeLocator(
            environment: [:],
            runVersionProbe: { path in
                recorder.recordVersionProbe(path)
                return path == cachedPath ? nil : "v22.16.0"
            },
            cachedPath: cachedPath,
            onLocated: { path in recorder.recordLocated(path) },
            runLoginShellPathProbe: {
                recorder.recordLoginShellProbe()
                return fallbackPath
            }
        )

        let located = try locator.locate()

        #expect(located.path == fallbackPath)
        #expect(recorder.versionProbePaths == [cachedPath, fallbackPath])
        #expect(recorder.loginShellProbeCount == 1)
        #expect(recorder.locatedPaths == [fallbackPath])
    }

    @Test("without a cache, normal discovery still persists the located path")
    func noCacheUsesNormalDiscovery() throws {
        let discoveredPath = try makeExecutableNodeFile()
        defer { try? FileManager.default.removeItem(atPath: discoveredPath) }

        let recorder = ProbeRecorder()
        let locator = NodeRuntimeLocator(
            environment: [:],
            runVersionProbe: { path in
                recorder.recordVersionProbe(path)
                return "v22.16.0"
            },
            onLocated: { path in recorder.recordLocated(path) },
            runLoginShellPathProbe: {
                recorder.recordLoginShellProbe()
                return discoveredPath
            }
        )

        let located = try locator.locate()

        #expect(located.path == discoveredPath)
        #expect(recorder.versionProbePaths == [discoveredPath])
        #expect(recorder.loginShellProbeCount == 1)
        #expect(recorder.locatedPaths == [discoveredPath])
    }
}

private final class ProbeRecorder: @unchecked Sendable {
    private(set) var versionProbePaths: [String] = []
    private(set) var locatedPaths: [String] = []
    private(set) var loginShellProbeCount = 0

    func recordVersionProbe(_ path: String) {
        versionProbePaths.append(path)
    }

    func recordLocated(_ path: String) {
        locatedPaths.append(path)
    }

    func recordLoginShellProbe() {
        loginShellProbeCount += 1
    }
}

private func makeExecutableNodeFile() throws -> String {
    let path = FileManager.default.temporaryDirectory
        .appendingPathComponent("sergecode-node-locator-\(UUID().uuidString)")
        .path
    guard FileManager.default.createFile(atPath: path, contents: Data()) else {
        throw NSError(domain: "NodeRuntimeLocatorTests", code: 1)
    }
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: path)
    return path
}
