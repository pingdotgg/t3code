import Foundation
import Testing
@testable import T3Code

struct MarkdownOpenURLDispositionTests {
    @Test(arguments: [
        "file:///private/other/App.swift",
        "file://server/share/repo/App.swift",
        "FiLe:///private/other/App.swift",
    ])
    func unhandledFileURLIsDiscarded(_ rawURL: String) throws {
        let url = try #require(URL(string: rawURL))

        #expect(MarkdownOpenURLDisposition.resolve(url: url, onOpenURL: nil) == .discarded)
    }

    @Test
    func unhandledWebURLUsesSystemAction() throws {
        let url = try #require(URL(string: "https://example.com/docs"))

        #expect(MarkdownOpenURLDisposition.resolve(url: url, onOpenURL: nil) == .systemAction)
    }

    @Test
    func explicitlyHandledURLIsHandled() throws {
        let url = try #require(URL(string: "file:///repo/App.swift"))

        #expect(
            MarkdownOpenURLDisposition.resolve(url: url, onOpenURL: { _ in true }) == .handled
        )
    }
}
