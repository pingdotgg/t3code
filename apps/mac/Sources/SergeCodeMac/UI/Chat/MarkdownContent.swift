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

    @UIState private var isHovering = false

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
                    .transition(.opacity)
            } else {
                // Copies the raw markdown, not the rendered text — pasted
                // content survives round-trips into editors and issues.
                CopyActionButton(text: markdown)
                    .opacity(isHovering ? 1 : 0)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onHover { isHovering = $0 }
        .animation(Motion.fade, value: isHovering)
        .animation(Motion.fade, value: isStreaming)
        .contextMenu {
            Button("Copy as Markdown") { Pasteboard.copy(markdown) }
        }
    }
}

// MARK: - Prose blocks

// SwiftUI `Text` renders inline markdown attributes but ignores
// `PresentationIntent` entirely — feeding a whole prose section through
// `AttributedString(markdown:, .full)` collapses paragraphs, headings and
// lists into one run-on blob. So prose is split into block-level pieces here
// and each block is laid out as its own view, with only the inline syntax
// (bold/italic/code/links) handed to AttributedString.

enum MarkdownBlock: Equatable {
    case paragraph(String)
    case heading(level: Int, text: String)
    case bulletItem(indent: Int, text: String)
    case orderedItem(number: String, text: String)
    case quote(String)
    case rule
}

/// Splits one prose segment (no code fences) into block-level pieces.
func parseMarkdownBlocks(_ prose: String) -> [MarkdownBlock] {
    var blocks: [MarkdownBlock] = []
    var paragraphLines: [String] = []

    func flushParagraph() {
        guard !paragraphLines.isEmpty else { return }
        blocks.append(.paragraph(paragraphLines.joined(separator: "\n")))
        paragraphLines.removeAll()
    }

    for rawLine in prose.split(separator: "\n", omittingEmptySubsequences: false) {
        let line = String(rawLine)
        let trimmed = line.trimmingCharacters(in: .whitespaces)

        if trimmed.isEmpty {
            flushParagraph()
            continue
        }
        if let heading = headingBlock(trimmed) {
            flushParagraph()
            blocks.append(heading)
            continue
        }
        if isRule(trimmed) {
            flushParagraph()
            blocks.append(.rule)
            continue
        }
        if let item = bulletBlock(line: line, trimmed: trimmed) {
            flushParagraph()
            blocks.append(item)
            continue
        }
        if let item = orderedBlock(trimmed) {
            flushParagraph()
            blocks.append(item)
            continue
        }
        if trimmed.hasPrefix(">") {
            flushParagraph()
            let text = trimmed.dropFirst().trimmingCharacters(in: .whitespaces)
            // Merge consecutive quote lines into one block.
            if case .quote(let existing)? = blocks.last {
                blocks[blocks.count - 1] = .quote(existing + "\n" + text)
            } else {
                blocks.append(.quote(text))
            }
            continue
        }
        // Continuation of a list item (indented follow-up line) folds into it.
        if line.first?.isWhitespace == true {
            switch blocks.last {
            case .bulletItem(let indent, let text)? where paragraphLines.isEmpty:
                blocks[blocks.count - 1] = .bulletItem(indent: indent, text: text + "\n" + trimmed)
                continue
            case .orderedItem(let number, let text)? where paragraphLines.isEmpty:
                blocks[blocks.count - 1] = .orderedItem(number: number, text: text + "\n" + trimmed)
                continue
            default:
                break
            }
        }
        paragraphLines.append(trimmed)
    }
    flushParagraph()
    return blocks
}

private func headingBlock(_ trimmed: String) -> MarkdownBlock? {
    guard trimmed.hasPrefix("#") else { return nil }
    let hashes = trimmed.prefix(while: { $0 == "#" })
    guard hashes.count <= 6 else { return nil }
    let rest = trimmed.dropFirst(hashes.count)
    guard rest.first == " " else { return nil }
    return .heading(level: hashes.count, text: rest.trimmingCharacters(in: .whitespaces))
}

private func isRule(_ trimmed: String) -> Bool {
    guard trimmed.count >= 3 else { return false }
    return trimmed.allSatisfy { $0 == "-" } || trimmed.allSatisfy { $0 == "*" }
        || trimmed.allSatisfy { $0 == "_" }
}

private func bulletBlock(line: String, trimmed: String) -> MarkdownBlock? {
    for marker in ["- ", "* ", "+ "] where trimmed.hasPrefix(marker) {
        let indent = line.prefix(while: \.isWhitespace).count >= 2 ? 1 : 0
        return .bulletItem(
            indent: indent, text: String(trimmed.dropFirst(marker.count)))
    }
    return nil
}

private func orderedBlock(_ trimmed: String) -> MarkdownBlock? {
    let digits = trimmed.prefix(while: \.isNumber)
    guard !digits.isEmpty, digits.count <= 3 else { return nil }
    let rest = trimmed.dropFirst(digits.count)
    guard rest.hasPrefix(". ") || rest.hasPrefix(") ") else { return nil }
    return .orderedItem(number: String(digits), text: String(rest.dropFirst(2)))
}

/// Inline-only markdown (bold/italic/code/links), newlines preserved.
private func inlineAttributed(_ text: String) -> AttributedString {
    let options = AttributedString.MarkdownParsingOptions(
        allowsExtendedAttributes: true,
        interpretedSyntax: .inlineOnlyPreservingWhitespace,
        failurePolicy: .returnPartiallyParsedIfPossible
    )
    return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
}

private struct MarkdownProseText: View {
    // Parsed once per view value, not per body evaluation — body re-runs on
    // every timeline mutation while this view's `raw` is unchanged.
    private let blocks: [MarkdownBlock]

    init(_ raw: String) {
        self.blocks = parseMarkdownBlocks(raw)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            // Position-keyed ids: content-hash ids collide on repeated blocks
            // (two rules, duplicate bullets), and positions are append-stable
            // while a message streams.
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func blockView(_ block: MarkdownBlock) -> some View {
        switch block {
        case .paragraph(let text):
            Text(inlineAttributed(text))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .heading(let level, let text):
            Text(inlineAttributed(text))
                .font(headingFont(level))
                .textSelection(.enabled)
                .padding(.top, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .bulletItem(let indent, let text):
            listRow(marker: "•", text: text, indent: indent)
        case .orderedItem(let number, let text):
            listRow(marker: "\(number).", text: text, indent: 0)
        case .quote(let text):
            HStack(alignment: .top, spacing: 8) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(.quaternary)
                    .frame(width: 3)
                Text(inlineAttributed(text))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        case .rule:
            Divider()
        }
    }

    private func listRow(marker: String, text: String, indent: Int) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            Text(marker)
                .foregroundStyle(.secondary)
                .monospacedDigit()
            Text(inlineAttributed(text))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.leading, CGFloat(indent) * 16 + 2)
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: .title2.weight(.bold)
        case 2: .title3.weight(.semibold)
        case 3: .headline
        default: .subheadline.weight(.semibold)
        }
    }
}

private struct MarkdownCodeBlock: View {
    let language: String?
    let code: String

    @UIState private var isHovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                if let language, !language.isEmpty {
                    Text(language.uppercased())
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                CopyActionButton(text: code)
                    .opacity(isHovering ? 1 : 0)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
            }
        }
        .onHover { isHovering = $0 }
        .animation(Motion.fade, value: isHovering)
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        // Solid opaque fill — code blocks live inside long-form assistant
        // text, so no glass/material here per Liquid Glass content rules.
        .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.separator, lineWidth: 1))
    }
}
