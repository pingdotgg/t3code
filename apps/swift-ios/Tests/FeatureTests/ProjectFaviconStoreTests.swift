import Foundation
import Testing
import UIKit
@testable import T3Code

@Suite("Project favicon cache")
struct ProjectFaviconStoreTests {
    @Test
    func persistsLastKnownIconAcrossStoreInstances() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let key = FeatureProjectFaviconCacheKey(
            environmentID: "leftbook",
            workspaceRoot: "/work/t3code/"
        )
        let data = Data("known-icon".utf8)
        let checkedAt = Date(timeIntervalSince1970: 1_000)

        let writer = FeatureProjectFaviconStore(directoryURL: directory)
        try await writer.record(
            data: data,
            revision: "v1-favicon.svg",
            for: key,
            checkedAt: checkedAt
        )

        let reader = FeatureProjectFaviconStore(directoryURL: directory)
        let value = try #require(try await reader.value(for: key))
        #expect(value.data == data)
        #expect(value.revision == "v1-favicon.svg")
        #expect(value.lastCheckedAt == checkedAt)
    }

    @Test
    func missingRemoteIconKeepsLastKnownProjectRelationship() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = FeatureProjectFaviconStore(directoryURL: directory)
        let key = FeatureProjectFaviconCacheKey(
            environmentID: "leftbook",
            workspaceRoot: "/work/t3code"
        )
        let data = Data("cached-icon".utf8)

        try await store.record(
            data: data,
            revision: "v1-favicon.svg",
            for: key,
            checkedAt: Date(timeIntervalSince1970: 1_000)
        )
        try await store.record(
            data: nil,
            revision: nil,
            for: key,
            checkedAt: Date(timeIntervalSince1970: 2_000)
        )

        let value = try #require(try await store.value(for: key))
        #expect(value.data == data)
        #expect(value.revision == "v1-favicon.svg")
        #expect(value.lastCheckedAt == Date(timeIntervalSince1970: 2_000))
    }

    @Test
    func projectKeysSeparateEnvironmentsAndNormalizePaths() {
        let first = FeatureProjectFaviconCacheKey(
            environmentID: "leftbook",
            workspaceRoot: "/work/./t3code/"
        )
        let sameProject = FeatureProjectFaviconCacheKey(
            environmentID: "leftbook",
            workspaceRoot: "/work/t3code"
        )
        let otherEnvironment = FeatureProjectFaviconCacheKey(
            environmentID: "big-o",
            workspaceRoot: "/work/t3code"
        )

        #expect(first == sameProject)
        #expect(first.fingerprint == sameProject.fingerprint)
        #expect(first != otherEnvironment)
        #expect(first.fingerprint != otherEnvironment.fingerprint)
    }

    @Test
    @MainActor
    func svgFaviconsAreRasterizedBeforeCaching() async throws {
        let data = Data(
            ##"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#00ff00"/></svg>"##.utf8
        )

        let renderable = try #require(
            await FeatureProjectFaviconImageDecoder.renderableData(from: data)
        )
        #expect(UIImage(data: renderable) != nil)
    }

    private func temporaryDirectory() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("project-favicon-cache-\(UUID().uuidString)")
    }
}
