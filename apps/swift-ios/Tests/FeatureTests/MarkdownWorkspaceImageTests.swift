import Foundation
import Testing
@testable import T3Code

@Suite("Markdown workspace images")
struct MarkdownWorkspaceImageTests {
    @Test
    func resolvesImageSourcesThroughWorkspaceFileLinks() throws {
        let relative = try #require(MarkdownWorkspaceImage(
            source: "./artifacts/demo%20image.png?download=1",
            workspaceRoot: "/repo"
        ))
        #expect(relative.link.path == "artifacts/demo image.png")

        let absolute = try #require(MarkdownWorkspaceImage(
            source: "/repo/artifacts/demo.png",
            workspaceRoot: "/repo"
        ))
        #expect(absolute.link.path == "artifacts/demo.png")

        let root = try #require(MarkdownWorkspaceImage(
            source: "screenshot.png",
            workspaceRoot: "/repo"
        ))
        #expect(root.link.path == "screenshot.png")

        let nested = try #require(MarkdownWorkspaceImage(
            source: "images/diagram.png",
            workspaceRoot: "/repo",
            relativeTo: "docs"
        ))
        #expect(nested.link.path == "docs/images/diagram.png")
        #expect(nested.previewURL.path == "/repo/docs/images/diagram.png")
    }

    @Test
    func rejectsExternalEscapingAndNonImageSources() {
        #expect(MarkdownWorkspaceImage(
            source: "https://example.com/demo.png",
            workspaceRoot: "/repo"
        ) == nil)
        #expect(MarkdownWorkspaceImage(
            source: "../outside.png",
            workspaceRoot: "/repo"
        ) == nil)
        #expect(MarkdownWorkspaceImage(
            source: "recordings/demo.mp4",
            workspaceRoot: "/repo"
        ) == nil)
        #expect(MarkdownWorkspaceImage(
            source: "images/demo.png",
            workspaceRoot: nil
        ) == nil)
    }
}
