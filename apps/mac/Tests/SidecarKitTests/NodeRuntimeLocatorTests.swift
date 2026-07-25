import Foundation
import Testing

@testable import SidecarKit

@Suite("Node runtime locator")
struct NodeRuntimeLocatorTests {
    @Test("a valid cached path skips the login-shell probe and persistence")
    func cachedValidShortCircuits() async throws {
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

        let located = try await locator.locate()

        #expect(located.path == cachedPath)
        #expect(recorder.versionProbePaths == [cachedPath])
        #expect(recorder.loginShellProbeCount == 0)
        #expect(recorder.locatedPaths.isEmpty)
    }

    @Test("a stale cached path falls through and refreshes the cache")
    func cachedStaleFallsThrough() async throws {
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

        let located = try await locator.locate()

        #expect(located.path == fallbackPath)
        #expect(recorder.versionProbePaths == [cachedPath, fallbackPath])
        #expect(recorder.loginShellProbeCount == 1)
        #expect(recorder.locatedPaths == [fallbackPath])
    }

    @Test("without a cache, normal discovery still persists the located path")
    func noCacheUsesNormalDiscovery() async throws {
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

        let located = try await locator.locate()

        #expect(located.path == discoveredPath)
        #expect(recorder.versionProbePaths == [discoveredPath])
        #expect(recorder.loginShellProbeCount == 1)
        #expect(recorder.locatedPaths == [discoveredPath])
    }

    @Test("bundled node path resolves an executable SergeCodeNode/node under the bundle resources")
    func bundledNodePath() throws {
        let resourceDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("sergecode-bundled-node-\(UUID().uuidString)")
        let nodeDir = resourceDir.appendingPathComponent("SergeCodeNode")
        try FileManager.default.createDirectory(at: nodeDir, withIntermediateDirectories: true)
        let node = nodeDir.appendingPathComponent("node")
        guard FileManager.default.createFile(atPath: node.path, contents: Data()) else {
            throw NSError(domain: "NodeRuntimeLocatorTests", code: 1)
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node.path)
        defer { try? FileManager.default.removeItem(at: resourceDir) }

        #expect(NodeRuntimeLocator.bundledNodePath(resourceURL: resourceDir) == node.path)
    }

    @Test("bundled node path is nil when the runtime is missing or not executable")
    func bundledNodePathMissingOrNotExecutable() throws {
        let resourceDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("sergecode-bundled-node-\(UUID().uuidString)")
        let nodeDir = resourceDir.appendingPathComponent("SergeCodeNode")
        try FileManager.default.createDirectory(at: nodeDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: resourceDir) }

        // Missing entirely.
        #expect(NodeRuntimeLocator.bundledNodePath(resourceURL: resourceDir) == nil)
        #expect(NodeRuntimeLocator.bundledNodePath(resourceURL: nil) == nil)

        // Present but not executable (e.g. lost exec bit during packaging).
        let node = nodeDir.appendingPathComponent("node")
        guard FileManager.default.createFile(atPath: node.path, contents: Data()) else {
            throw NSError(domain: "NodeRuntimeLocatorTests", code: 1)
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: node.path)
        #expect(NodeRuntimeLocator.bundledNodePath(resourceURL: resourceDir) == nil)
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
