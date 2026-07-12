import Foundation

public final class Highlight: Sendable {
    private let hljs = HLJS()

    public init() { }

    /// Syntax highlight some text with automatic language detection.
    /// - Parameters:
    ///   - text: The plain text code to highlight.
    ///   - colors: The highlight colors to use (default: .xcode/.light).
    /// - Throws: Either a HighlightError or an Error.
    /// - Returns: A syntax highlighted attributed string.
    public func attributedText(_ text: String,
                               colors: HighlightColors = .light(.xcode)) async throws -> AttributedString {
        try await request(text, mode: .automatic, colors: colors).attributedText
    }

    /// Syntax highlight some text with a specific language.
    /// - Parameters:
    ///   - text: The plain text code to highlight.
    ///   - language: The supported language to use.
    ///   - colors: The highlight colors to use (default: .xcode/.light).
    /// - Throws: Either a HighlightError or an Error.
    /// - Returns: A syntax highlighted attributed string.
    public func attributedText(_ text: String,
                               language: HighlightLanguage,
                               colors: HighlightColors = .light(.xcode)) async throws -> AttributedString {
        try await request(text, mode: .language(language), colors: colors).attributedText
    }

    /// Syntax highlight some text with a specific language.
    /// - Parameters:
    ///   - text: The plain text code to highlight.
    ///   - language: The language alias to use.
    ///   - colors: The highlight colors to use (default: .xcode/.light).
    /// - Throws: Either a HighlightError or an Error.
    /// - Returns: A syntax highlighted attributed string.
    public func attributedText(_ text: String,
                               language: String,
                               colors: HighlightColors = .light(.xcode)) async throws -> AttributedString {
        try await request(text, mode: .languageAlias(language), colors: colors).attributedText
    }

    /// Syntax highlight some text and return detailed results.
    /// - Parameters:
    ///   - text: The plain text code to highlight.
    ///   - mode: The highlight mode to use (default: .automatic).
    ///   - colors: The highlight colors to use (default: .xcode/.light).
    /// - Throws: Either a HighlightError or an Error.
    /// - Returns: The result of the syntax highlight.
    public func request(_ text: String,
                        mode: HighlightMode = .automatic,
                        colors: HighlightColors = .light(.xcode)) async throws -> HighlightResult {
        let hljsResult = try await hljs.highlight(text, mode: mode)
        let isUndefined = hljsResult.value == "undefined"
        let attributedText: AttributedString
        if isUndefined {
            attributedText = AttributedString(stringLiteral: text)
        } else {
            let data = try htmlDataFromText(hljsResult.value, selectors: colors.css)
            attributedText = try await attributedTextFromData(data)
        }
        return HighlightResult(
            attributedText: attributedText,
            highlightJSResult: hljsResult,
            backgroundColorHex: colors.background
        )
    }

    private func htmlDataFromText(_ text: String, selectors: String) throws -> Data {
        let html = "<style>\n"
            .appending(selectors)
            .appending("\n</style>")
            .appending("\n<pre><code class=\"hljs\">")
            // SergeCode: preserve code indentation and blank lines; the HTML
            // importer is responsible for adding exactly one trailing newline.
            .appending(text)
            .appending("</code></pre>")
        return html.data(using: .utf8) ?? Data()
    }

    // SergeCode: AppKit's HTML importer is WebKit-backed and main-thread-only.
    @MainActor
    private func attributedTextFromData(_ data: Data) throws -> AttributedString {
        let mutableString = try NSMutableAttributedString(
            data: data,
            options: [
                .documentType: NSAttributedString.DocumentType.html,
                .characterEncoding: String.Encoding.utf8.rawValue
            ],
            documentAttributes: nil
        )
        mutableString.removeAttribute(
            .font,
            range: NSMakeRange(0, mutableString.length)
        )
        // SergeCode: strip only the one newline inserted by the HTML importer;
        // source trailing newlines remain because the importer leaves them
        // immediately before its own final newline.
        let importerNewline = mutableString.string.hasSuffix("\n") ? 1 : 0
        let range = NSRange(
            location: 0,
            length: max(0, mutableString.length - importerNewline))
        let attributedString = mutableString.attributedSubstring(from: range)
#if os(macOS)
        return try AttributedString(attributedString, including: \.appKit)
#else
        return try AttributedString(attributedString, including: \.uiKit)
#endif
    }
}
