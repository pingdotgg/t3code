import Testing
import UIKit
@testable import T3Code

@Suite("Inline workspace images")
struct MarkdownWorkspaceImageTests {
    @Test
    func resolvesRelativeWorkspaceImagePaths() {
        #expect(
            MarkdownWorkspaceImageReference.workspacePath(for: "out/render.png")
                == "out/render.png"
        )
        #expect(
            MarkdownWorkspaceImageReference.workspacePath(for: "./docs/./diagram.JPEG")
                == "docs/diagram.JPEG"
        )
        #expect(
            MarkdownWorkspaceImageReference.workspacePath(for: "art/my%20chart.webp")
                == "art/my chart.webp"
        )
        #expect(
            MarkdownWorkspaceImageReference.workspacePath(for: "  logo.gif  ") == "logo.gif"
        )
    }

    @Test
    func acceptsUnescapedPunctuationInFileNames() {
        // The parser hands over an unescaped path, so a file whose name needs
        // Markdown escaping still resolves to the file on disk.
        #expect(
            MarkdownWorkspaceImageReference.workspacePath(for: "out/foo(1).png")
                == "out/foo(1).png"
        )
        #expect(
            MarkdownWorkspaceImageReference.workspacePath(for: "out/a [b].png")
                == "out/a [b].png"
        )
    }

    @Test
    func rejectsReferencesThatAreNotWorkspaceImages() {
        for source in [
            "https://example.com/render.png",
            "data:image/png;base64,AAAA",
            "file:///tmp/render.png",
            "/tmp/render.png",
            "~/render.png",
            "#anchor",
            "../../secrets/render.png",
            "out//render.png",
            "notes.txt",
            "render.png/",
            "",
            "   ",
        ] {
            #expect(
                MarkdownWorkspaceImageReference.workspacePath(for: source) == nil,
                "Expected \(source) to stay alternative text"
            )
        }
    }

    @Test
    func matchesTheFilePreviewImageContract() {
        // Inline images and the file browser must agree on what is an image.
        for path in ["a.png", "a.jpg", "a.jpeg", "a.gif", "a.webp", "a.avif", "a.ico"] {
            #expect(MarkdownWorkspaceImageReference.workspacePath(for: path) == path)
            #expect(FeatureFilePreviewKind.infer(path: path) == .image)
        }
        for path in ["a.svg", "a.mp4", "a.md", "a.swift"] {
            #expect(MarkdownWorkspaceImageReference.workspacePath(for: path) == nil)
            #expect(FeatureFilePreviewKind.infer(path: path) != .image)
        }
    }

    @MainActor
    @Test(
        "Repeated loads re-resolve a workspace image",
        .bug("https://github.com/pingdotgg/t3code/pull/7378#discussion_r3802336559")
    )
    func repeatedLoadsResolveFreshAssetURLs() async throws {
        let urls = [
            try #require(URL(string: "https://example.test/assets/render-v1.png")),
            try #require(URL(string: "https://example.test/assets/render-v2.png")),
        ]
        let resolver = SequentialWorkspaceAssetResolver(urls: urls)
        var loadedURLs: [URL] = []

        for _ in urls {
            _ = try await MarkdownWorkspaceImageLoader.image(
                threadID: "thread-1",
                path: "out/render.png",
                maximumPixelSize: 780,
                resolver: resolver
            ) { url, _ in
                loadedURLs.append(url)
                return UIImage()
            }
        }

        #expect(resolver.requests == [
            .init(threadID: "thread-1", path: "out/render.png"),
            .init(threadID: "thread-1", path: "out/render.png"),
        ])
        #expect(loadedURLs == urls)
    }
}

@MainActor
private final class SequentialWorkspaceAssetResolver: FeatureWorkspaceAssetResolving {
    struct Request: Equatable {
        let threadID: String
        let path: String
    }

    private var urls: [URL]
    private(set) var requests: [Request] = []

    init(urls: [URL]) {
        self.urls = urls
    }

    func workspaceAssetURL(threadID: String, path: String) async throws -> URL {
        requests.append(.init(threadID: threadID, path: path))
        return urls.removeFirst()
    }
}
