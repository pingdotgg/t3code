import Foundation
import Testing
@testable import T3Code

@Suite("Markdown embedded media")
@MainActor
struct MarkdownEmbeddedMediaTests {
    @Test
    func hostVideoUsesTheSignedVideoRouteInsteadOfTheImageDecoder() throws {
        let media = MarkdownEmbeddedMedia("./output/demo.mp4", workspaceRoot: "/workspace/project")
        #expect(media.isVideo)
        #expect(media.source == .workspaceFile("/workspace/project/./output/demo.mp4"))
        let previewURL = try #require(media.previewURL)
        let route = try #require(FeatureTypedMediaPreviewRoute.parse(previewURL))
        #expect(route.kind == .video)
        #expect(route.path == "/workspace/project/./output/demo.mp4")
    }

    @Test
    func urlsAndHostPathsAreDecodedOnceForClassification() {
        #expect(MarkdownEmbeddedMedia("https://example.com/demo.MP4?download=1#t=5").isVideo)
        #expect(MarkdownEmbeddedMedia("file:///tmp/demo%23one.mp4").isVideo)
        #expect(MarkdownEmbeddedMedia("file:///tmp/demo.mp4%3Fpng").isVideo == false)
        #expect(MarkdownEmbeddedMedia("C:\\output\\demo.mov").isVideo)
        #expect(!MarkdownEmbeddedMedia("https://example.com/image.png?name=demo.mp4").isVideo)
        #expect(!MarkdownEmbeddedMedia("https://example.com/image-endpoint").isVideo)
        #expect(MarkdownEmbeddedMedia("javascript:demo.mp4").source == .blocked)
    }

    @Test
    func hostMediaResolvesFreshOnEveryPlaybackAttempt() async throws {
        let resolver = MediaResolver()
        let context = MarkdownImageContext(threadID: "thread-a", workspaceRoot: "/repo", resolver: resolver)
        let media = MarkdownEmbeddedMedia("demo.mp4", workspaceRoot: context.mediaBasePath)
        let first = try await media.resolveURL(context: context)
        let retry = try await media.resolveURL(context: context)
        #expect(first != retry)
        #expect(resolver.requests.map(\.threadID) == ["thread-a", "thread-a"])
        #expect(resolver.requests.map(\.path) == ["/repo/demo.mp4", "/repo/demo.mp4"])
    }

    @Test
    func capturedMarkdownCannotReadHostVideoWithoutAResolver() async {
        let media = MarkdownEmbeddedMedia("file:///tmp/demo.mp4")
        await #expect(throws: FeatureCapabilityUnavailable.self) {
            try await media.resolveURL(context: nil)
        }
    }

    @Test
    func viewedMarkdownResolvesMediaRelativeToItsOwnDirectory() {
        let context = MarkdownImageContext(
            threadID: "thread-a", workspaceRoot: "/repo", resolver: MediaResolver(),
            sourceFilePath: "/repo/docs/README.md"
        )
        #expect(MarkdownEmbeddedMedia("demo.mp4", workspaceRoot: context.mediaBasePath).source == .workspaceFile("/repo/docs/demo.mp4"))
    }
}

@MainActor
private final class MediaResolver: FeatureWorkspaceAssetResolving {
    var requests: [(threadID: String, path: String)] = []

    func workspaceAssetURL(threadID: String, path: String) async throws -> URL {
        requests.append((threadID, path))
        return URL(string: "https://environment.test/api/assets/video?signature=\(requests.count)")!
    }
}
