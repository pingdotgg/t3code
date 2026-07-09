import Foundation
import Testing

@testable import SergeCodeMac

// Unit tests for clickable file-path detection in assistant markdown:
// URL codec (fileLinkURL / parseFileLinkURL) and linkifyFilePaths over
// AttributedString runs produced like MarkdownContent.inlineAttributed.

@Suite("File link detection")
@MainActor
struct FileLinkDetectionTests {

    // MARK: - Helpers

    private func inlineAttributed(_ text: String) throws -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            allowsExtendedAttributes: true,
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        return try AttributedString(markdown: text, options: options)
    }

    /// Collects (visible text, parsed target) for every sergecode-file link run.
    private func fileLinkTargets(in attributed: AttributedString) -> [(text: String, target: FileLinkTarget)] {
        var found: [(text: String, target: FileLinkTarget)] = []
        for run in attributed.runs {
            guard let url = run.link, let target = parseFileLinkURL(url) else { continue }
            let text = String(attributed.characters[run.range])
            found.append((text, target))
        }
        return found
    }

    private func httpsLinks(in attributed: AttributedString) -> [URL] {
        attributed.runs.compactMap { run in
            guard let url = run.link, url.scheme?.lowercased() == "https" || url.scheme?.lowercased() == "http"
            else { return nil }
            return url
        }
    }

    private func assertRoundTrip(
        path: String,
        line: Int?,
        sourceLocation: SourceLocation = #_sourceLocation
    ) {
        guard let url = fileLinkURL(path: path, line: line) else {
            Issue.record("fileLinkURL returned nil for path=\(path) line=\(String(describing: line))",
                         sourceLocation: sourceLocation)
            return
        }
        guard let parsed = parseFileLinkURL(url) else {
            Issue.record("parseFileLinkURL returned nil for \(url)", sourceLocation: sourceLocation)
            return
        }
        #expect(parsed.path == path, sourceLocation: sourceLocation)
        #expect(parsed.line == line, sourceLocation: sourceLocation)
    }

    // MARK: - URL codec round-trip

    @Test("fileLinkURL/parseFileLinkURL round-trip: relative path")
    func roundTripRelativePath() {
        assertRoundTrip(path: "src/foo.ts", line: nil)
        assertRoundTrip(path: "src/foo.ts", line: 12)
        assertRoundTrip(path: "apps/mac/Sources/Foo.swift", line: 10)
    }

    @Test("fileLinkURL/parseFileLinkURL round-trip: absolute path")
    func roundTripAbsolutePath() {
        assertRoundTrip(path: "/tmp/foo.ts", line: nil)
        assertRoundTrip(path: "/Users/serge/proj/src/bar.swift", line: 42)
    }

    @Test("fileLinkURL/parseFileLinkURL round-trip: spaces and unicode")
    func roundTripSpacesAndUnicode() {
        assertRoundTrip(path: "src/my file.ts", line: nil)
        assertRoundTrip(path: "src/my file.ts", line: 7)
        assertRoundTrip(path: "src/файлы/тест.swift", line: 3)
        assertRoundTrip(path: "docs/日本語/readme.md", line: nil)
    }

    // MARK: - parseFileLinkURL rejection

    @Test("parseFileLinkURL rejects non-sergecode-file schemes")
    func rejectsNonFileSchemes() throws {
        let https = try #require(URL(string: "https://example.com/src/foo.ts"))
        #expect(parseFileLinkURL(https) == nil)

        let fileScheme = try #require(URL(string: "file:///src/foo.ts"))
        #expect(parseFileLinkURL(fileScheme) == nil)

        let other = try #require(URL(string: "sergecode-other:///src/foo.ts"))
        #expect(parseFileLinkURL(other) == nil)
    }

    @Test("parseFileLinkURL rejects malformed fragments")
    func rejectsMalformedFragments() throws {
        // Fragment must be L + integer (e.g. #L12), not bare numbers or other shapes.
        let noL = try #require(URL(string: "sergecode-file:///src/foo.ts#12"))
        #expect(parseFileLinkURL(noL) == nil)

        let nonNumeric = try #require(URL(string: "sergecode-file:///src/foo.ts#Labc"))
        #expect(parseFileLinkURL(nonNumeric) == nil)

        let emptyL = try #require(URL(string: "sergecode-file:///src/foo.ts#L"))
        #expect(parseFileLinkURL(emptyL) == nil)

        let lineColStyle = try #require(URL(string: "sergecode-file:///src/foo.ts#L3:7"))
        #expect(parseFileLinkURL(lineColStyle) == nil)
    }

    // MARK: - Inline code spans

    @Test("inline code span with path:line is linkified")
    func inlineCodePathWithLine() throws {
        let input = try inlineAttributed("see `src/foo.ts:12`")
        let output = linkifyFilePaths(in: input)
        let links = fileLinkTargets(in: output)
        #expect(links.count == 1)
        #expect(links[0].target.path == "src/foo.ts")
        #expect(links[0].target.line == 12)
        // Linked run is the code-span contents (no surrounding prose).
        #expect(links[0].text == "src/foo.ts:12")
    }

    @Test("inline code bare filename with line is linkified; without line is not")
    func inlineCodeBareFilename() throws {
        // Regex allows bare `Package.swift:12` (filename + line) inside code spans.
        let withLine = try inlineAttributed("open `Package.swift:12`")
        let withLineOut = linkifyFilePaths(in: withLine)
        let withLineLinks = fileLinkTargets(in: withLineOut)
        #expect(withLineLinks.count == 1)
        #expect(withLineLinks[0].target.path == "Package.swift")
        #expect(withLineLinks[0].target.line == 12)

        // Bare filename without line is NOT matched by inlineCodeFilePathExpression
        // (second alt requires :\\d+; first alt requires a directory slash).
        let bare = try inlineAttributed("see `Package.swift`")
        let bareOut = linkifyFilePaths(in: bare)
        #expect(fileLinkTargets(in: bareOut).isEmpty)
    }

    // MARK: - Plain text

    @Test("plain text path with line is linkified; non-paths are not")
    func plainTextLinkifyRules() {
        let pathy = linkifyFilePaths(in: AttributedString("see apps/mac/Sources/Foo.swift:10 please"))
        let pathLinks = fileLinkTargets(in: pathy)
        #expect(pathLinks.count == 1)
        #expect(pathLinks[0].target.path == "apps/mac/Sources/Foo.swift")
        #expect(pathLinks[0].target.line == 10)
        #expect(pathLinks[0].text == "apps/mac/Sources/Foo.swift:10")

        // "and/or" has a slash but no file extension — plain regex requires \\.[A-Za-z0-9]{1,8}.
        let andOr = linkifyFilePaths(in: AttributedString("use and/or carefully"))
        #expect(fileLinkTargets(in: andOr).isEmpty)

        // Bare filename without directory is not matched by plainFilePathExpression
        // (requires at least one path segment with /).
        let bare = linkifyFilePaths(in: AttributedString("just foo.ts here"))
        #expect(fileLinkTargets(in: bare).isEmpty)
    }

    // MARK: - HTTP skip

    @Test("existing https markdown links are preserved; bare https not file-linked")
    func httpSkip() throws {
        let markdownLink = try inlineAttributed("[x](https://example.com/a/b.html)")
        let markdownOut = linkifyFilePaths(in: markdownLink)
        #expect(fileLinkTargets(in: markdownOut).isEmpty)
        let https = httpsLinks(in: markdownOut)
        #expect(https.count == 1)
        #expect(https[0].absoluteString == "https://example.com/a/b.html")

        // Bare URL text: path-like suffix must not become a sergecode-file link.
        let bareURL = linkifyFilePaths(in: AttributedString("see https://example.com/a/b.html now"))
        #expect(fileLinkTargets(in: bareURL).isEmpty)
    }

    // MARK: - Multiple matches (index stability)

    @Test("two plain-text paths in one run both get distinct links")
    func multiplePlainTextMatches() {
        let input = AttributedString("compare src/a.ts:1 with src/b.ts:2")
        let output = linkifyFilePaths(in: input)
        let links = fileLinkTargets(in: output)
        #expect(links.count == 2)

        let byPath = Dictionary(uniqueKeysWithValues: links.map { ($0.target.path, $0.target) })
        #expect(byPath["src/a.ts"]?.line == 1)
        #expect(byPath["src/b.ts"]?.line == 2)

        let texts = Set(links.map(\.text))
        #expect(texts == Set(["src/a.ts:1", "src/b.ts:2"]))
    }

    @Test("two separate inline code spans each get the correct link")
    func multipleInlineCodeSpans() throws {
        let input = try inlineAttributed("compare `src/a.ts:1` with `src/b.ts:2`")
        let output = linkifyFilePaths(in: input)
        let links = fileLinkTargets(in: output)
        #expect(links.count == 2)

        let byPath = Dictionary(uniqueKeysWithValues: links.map { ($0.target.path, $0.target) })
        #expect(byPath["src/a.ts"]?.line == 1)
        #expect(byPath["src/b.ts"]?.line == 2)
    }

    // MARK: - line:col suffix

    @Test(":line:col suffix yields path and first line number")
    func lineColSuffix() {
        let plain = linkifyFilePaths(in: AttributedString("at src/a.ts:3:7"))
        let plainLinks = fileLinkTargets(in: plain)
        #expect(plainLinks.count == 1)
        #expect(plainLinks[0].target.path == "src/a.ts")
        #expect(plainLinks[0].target.line == 3)
        #expect(plainLinks[0].text == "src/a.ts:3:7")
    }

    @Test(":line:col inside inline code span")
    func lineColSuffixInlineCode() throws {
        let input = try inlineAttributed("at `src/a.ts:3:7`")
        let output = linkifyFilePaths(in: input)
        let links = fileLinkTargets(in: output)
        #expect(links.count == 1)
        #expect(links[0].target.path == "src/a.ts")
        #expect(links[0].target.line == 3)
    }
}
