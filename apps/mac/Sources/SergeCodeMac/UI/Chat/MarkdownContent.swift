import Foundation
import SwiftUI

// Markdown rendering for assistant messages. AttributedString(markdown:) has
// no concept of fenced code blocks (it either fails to parse them or mangles
// them), so we split the raw text into prose/code segments ourselves and only
// hand the prose segments to AttributedString.

enum MarkdownSegment: Identifiable {
    case prose(String)
    case code(language: String?, code: String)

    var id: String {
        switch self {
        case .prose(let text): "prose-\(text.hashValue)"
        case .code(let language, let code): "code-\(language ?? "")-\(code.hashValue)"
        }
    }
}

/// Splits `markdown` on ``` fences into alternating prose / code segments.
/// Tolerates an unterminated trailing fence (the common case mid-stream while
/// an assistant message is still arriving) by flushing whatever code has
/// arrived so far.
func parseMarkdownSegments(_ markdown: String) -> [MarkdownSegment] {
    var segments: [MarkdownSegment] = []
    var proseLines: [Substring] = []
    var codeLines: [Substring] = []
    var codeLanguage: String?
    var inCode = false

    func flushProse() {
        guard !proseLines.isEmpty else { return }
        let text = proseLines.joined(separator: "\n")
        if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            segments.append(.prose(text))
        }
        proseLines.removeAll()
    }

    func flushCode() {
        let code = codeLines.joined(separator: "\n")
        segments.append(.code(language: codeLanguage, code: code))
        codeLines.removeAll()
        codeLanguage = nil
    }

    for line in markdown.split(separator: "\n", omittingEmptySubsequences: false) {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("```") {
            if inCode {
                flushCode()
                inCode = false
            } else {
                flushProse()
                let lang = trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces)
                codeLanguage = lang.isEmpty ? nil : lang
                inCode = true
            }
            continue
        }
        if inCode {
            codeLines.append(line)
        } else {
            proseLines.append(line)
        }
    }

    if inCode {
        flushCode()
    } else {
        flushProse()
    }
    return segments
}

/// Full-width assistant message body: parsed markdown segments plus a
/// streaming indicator. Always rendered on an opaque background — never
/// glass, this is long-form reading content.
struct AssistantMarkdownView: View {
    let markdown: String
    let isStreaming: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(parseMarkdownSegments(markdown)) { segment in
                switch segment {
                case .prose(let text):
                    MarkdownProseText(text)
                case .code(let language, let code):
                    MarkdownCodeBlock(language: language, code: code)
                }
            }
            if isStreaming {
                Image(systemName: "ellipsis")
                    .symbolEffect(.variableColor.iterative)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Assistant is responding")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct MarkdownProseText: View {
    private let raw: String

    init(_ raw: String) {
        self.raw = raw
    }

    var body: some View {
        Text(attributed)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var attributed: AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            allowsExtendedAttributes: true,
            interpretedSyntax: .full,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        return (try? AttributedString(markdown: raw, options: options)) ?? AttributedString(raw)
    }
}

private struct MarkdownCodeBlock: View {
    let language: String?
    let code: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let language, !language.isEmpty {
                Text(language.uppercased())
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        // Solid opaque fill — code blocks live inside long-form assistant
        // text, so no glass/material here per Liquid Glass content rules.
        .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.separator, lineWidth: 1))
    }
}
