import DesignKit
import SwiftUI

struct MarkdownView: View {
    let source: String
    @Environment(\.connTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: Kit.Space.m) {
            ForEach(Array(parseBlocks(source).enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func blockView(_ block: MarkdownBlock) -> some View {
        switch block {
        case let .heading(level, text):
            inlineMarkdownText(text)
                .font(headingFont(for: level))
                .foregroundStyle(theme.foreground)
                .textSelection(.enabled)
                .padding(.top, level <= 2 ? Kit.Space.xs : 0)

        case let .paragraph(text):
            inlineMarkdownText(text)
                .font(.kitBody)
                .foregroundStyle(theme.foreground)
                .textSelection(.enabled)

        case let .codeBlock(language, code):
            VStack(alignment: .leading, spacing: 0) {
                if let language, !language.isEmpty {
                    Text(language)
                        .font(.kitDetail.monospaced())
                        .foregroundStyle(theme.mutedForeground)
                        .padding(.horizontal, Kit.Space.l)
                        .padding(.top, Kit.Space.s)
                        .padding(.bottom, Kit.Space.xs)
                }
                ScrollView(.horizontal, showsIndicators: true) {
                    Text(code)
                        .font(.kitMono)
                        .foregroundStyle(theme.codeForeground)
                        .textSelection(.enabled)
                        .padding(.horizontal, Kit.Space.l)
                        .padding(.vertical, Kit.Space.m)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: Kit.Radius.group, style: .continuous)
                    .fill(theme.codeBackground)
            )
            .overlay(
                RoundedRectangle(cornerRadius: Kit.Radius.group, style: .continuous)
                    .strokeBorder(theme.border, lineWidth: 0.5)
            )

        case let .listItem(marker, text):
            HStack(alignment: .firstTextBaseline, spacing: Kit.Space.s) {
                Text(marker)
                    .font(.kitBody)
                    .foregroundStyle(theme.mutedForeground)
                    .frame(minWidth: 16, alignment: .trailing)
                inlineMarkdownText(text)
                    .font(.kitBody)
                    .foregroundStyle(theme.foreground)
                    .textSelection(.enabled)
            }
        }
    }

    private func headingFont(for level: Int) -> Font {
        switch level {
        case 1: .title2.weight(.semibold)
        case 2: .title3.weight(.semibold)
        case 3: .headline
        default: .subheadline.weight(.semibold)
        }
    }

    private func inlineMarkdownText(_ raw: String) -> Text {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        if let parsed = try? AttributedString(markdown: raw, options: options) {
            return Text(parsed)
        }
        return Text(raw)
    }
}

private enum MarkdownBlock {
    case heading(level: Int, text: String)
    case paragraph(String)
    case codeBlock(language: String?, code: String)
    case listItem(marker: String, text: String)
}

private func parseBlocks(_ source: String) -> [MarkdownBlock] {
    let lines = source.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    var blocks: [MarkdownBlock] = []
    var paragraphLines: [String] = []
    var index = 0

    func flushParagraph() {
        let joined = paragraphLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        if !joined.isEmpty {
            blocks.append(.paragraph(joined))
        }
        paragraphLines.removeAll()
    }

    while index < lines.count {
        let line = lines[index]
        let trimmed = line.trimmingCharacters(in: .whitespaces)

        if trimmed.hasPrefix("```") {
            flushParagraph()
            let lang = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
            var codeLines: [String] = []
            index += 1
            while index < lines.count {
                if lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    index += 1
                    break
                }
                codeLines.append(lines[index])
                index += 1
            }
            blocks.append(.codeBlock(language: lang.isEmpty ? nil : lang, code: codeLines.joined(separator: "\n")))
            continue
        }

        if trimmed.isEmpty {
            flushParagraph()
            index += 1
            continue
        }

        if let (level, headingText) = parseHeading(trimmed) {
            flushParagraph()
            blocks.append(.heading(level: level, text: headingText))
            index += 1
            continue
        }

        if let (marker, itemText) = parseListItem(trimmed) {
            flushParagraph()
            blocks.append(.listItem(marker: marker, text: itemText))
            index += 1
            continue
        }

        paragraphLines.append(line)
        index += 1
    }

    flushParagraph()
    return blocks
}

private func parseHeading(_ line: String) -> (Int, String)? {
    var hashes = 0
    for ch in line {
        if ch == "#" { hashes += 1 } else { break }
    }
    guard (1...6).contains(hashes) else { return nil }
    let rest = line.dropFirst(hashes)
    guard rest.first == " " else { return nil }
    return (hashes, String(rest.dropFirst()).trimmingCharacters(in: .whitespaces))
}

private func parseListItem(_ line: String) -> (String, String)? {
    if line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("• ") {
        return ("•", String(line.dropFirst(2)))
    }
    var digits = ""
    for ch in line {
        if ch.isNumber {
            digits.append(ch)
        } else if ch == "." && !digits.isEmpty {
            let afterDot = line.dropFirst(digits.count + 1)
            if afterDot.first == " " {
                return ("\(digits).", String(afterDot.dropFirst()))
            }
            return nil
        } else {
            return nil
        }
    }
    return nil
}
