import DesignKit
import SwiftUI

struct MarkdownView: View {
    let source: String
    /// An agent's earlier text beside a question: a size smaller, in the muted colour.
    var fillsWidth = true
    var muted = false
    var onTemplate: ((String) -> Void)? = nil
    @Environment(\.connTheme) private var theme

    private var bodyFont: Font { muted ? .system(size: 15) : .kitBody }
    private var textColor: Color { muted ? theme.mutedForeground : theme.foreground }

    var body: some View {
        VStack(alignment: .leading, spacing: Kit.Space.m) {
            ForEach(Array(parseBlocks(source).enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .frame(maxWidth: fillsWidth ? .infinity : nil, alignment: .leading)
    }

    @ViewBuilder
    private func blockView(_ block: MarkdownBlock) -> some View {
        switch block {
        case let .heading(level, text):
            inlineMarkdownText(text)
                .font(headingFont(for: level))
                .foregroundStyle(textColor)
                .textSelection(.enabled)
                .padding(.top, level <= 2 ? Kit.Space.xs : 0)

        case let .paragraph(text):
            inlineMarkdownText(text)
                .font(bodyFont)
                .foregroundStyle(textColor)
                .textSelection(.enabled)

        case let .codeBlock(language, code):
            CodeCard(code: code, language: language)

        case let .quote(text):
            HStack(spacing: 10) {
                Capsule().fill(theme.border).frame(width: 3)
                inlineMarkdownText(text).foregroundStyle(theme.mutedForeground).textSelection(.enabled)
            }

        case let .table(rows):
            ScrollView(.horizontal) {
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 7) {
                    ForEach(rows.indices, id: \.self) { i in
                        GridRow {
                            ForEach(rows[i].indices, id: \.self) { j in
                                inlineMarkdownText(rows[i][j]).fontWeight(i == 0 ? .semibold : .regular)
                            }
                        }
                        if i == 0 { Divider() }
                    }
                }
                .font(.system(size: 14)).textSelection(.enabled).padding(10)
            }
            .background(theme.card, in: .rect(cornerRadius: 10))

        case let .template(template, raw):
            if let onTemplate {
                ThreadCard {
                    Label("Artifact template", systemImage: "doc.text")
                } content: {
                    Button { onTemplate(template.prompt) } label: {
                        HStack {
                            Text(template.name)
                            Spacer()
                            Image(systemName: "square.and.pencil")
                        }.padding(12)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Start a draft with " + template.name)
                }
            } else {
                Text(raw).textSelection(.enabled)
            }

        case let .listItem(marker, text):
            HStack(alignment: .firstTextBaseline, spacing: Kit.Space.s) {
                Text(marker)
                    .font(bodyFont)
                    .foregroundStyle(theme.mutedForeground)
                    .frame(minWidth: 16, alignment: .trailing)
                inlineMarkdownText(text)
                    .font(bodyFont)
                    .foregroundStyle(textColor)
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
        if var parsed = try? AttributedString(markdown: raw, options: options) {
            for run in parsed.runs {
                if run.inlinePresentationIntent?.contains(.code) == true {
                    let snippet = String(parsed[run.range].characters)
                    if looksLikeFilePath(snippet) {
                        parsed[run.range].foregroundColor = theme.primary
                    }
                }
            }
            return Text(parsed)
        }
        return Text(raw)
    }

    private func looksLikeFilePath(_ s: String) -> Bool {
        let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.contains(" ") else { return false }
        if trimmed.hasSuffix("/") || trimmed.contains("/") { return true }
        let exts = [".rs", ".ts", ".tsx", ".swift", ".md", ".toml", ".json", ".yml", ".yaml", ".sh", ".py"]
        return exts.contains { trimmed.lowercased().hasSuffix($0) }
    }
}

private enum MarkdownBlock {
    case heading(level: Int, text: String)
    case paragraph(String)
    case quote(String)
    case table([[String]])
    case template(ArtifactTemplate, String)
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

        if let marker = trimmed.first, marker == "`" || marker == "~", trimmed.prefix(while: { $0 == marker }).count >= 3 {
            let fence = trimmed.prefix(while: { $0 == marker })
            flushParagraph()
            let lang = String(trimmed.dropFirst(fence.count)).trimmingCharacters(in: .whitespaces)
            var codeLines: [String] = []
            index += 1
            while index < lines.count {
                let closer = lines[index].trimmingCharacters(in: .whitespaces)
                if closer.count >= fence.count, closer.allSatisfy({ $0 == marker }) {
                    index += 1
                    break
                }
                codeLines.append(lines[index])
                index += 1
            }
            blocks.append(.codeBlock(language: lang.isEmpty ? nil : lang, code: codeLines.joined(separator: "\n")))
            continue
        }

        if let template = ArtifactTemplate(directive: trimmed) {
            flushParagraph()
            blocks.append(.template(template, line))
            index += 1
            continue
        }
        if trimmed.hasPrefix(">") {
            flushParagraph()
            var quote: [String] = []
            while index < lines.count, lines[index].trimmingCharacters(in: .whitespaces).hasPrefix(">") {
                let line = lines[index].trimmingCharacters(in: .whitespaces).dropFirst()
                quote.append(String(line).trimmingCharacters(in: .whitespaces))
                index += 1
            }
            blocks.append(.quote(quote.joined(separator: "\n")))
            continue
        }
        if trimmed.contains("|"), index + 1 < lines.count {
            let separators = tableCells(lines[index + 1])
            let headings = tableCells(trimmed)
            if headings.count > 1, headings.count == separators.count,
               separators.allSatisfy({ $0.range(of: #"^:?-{3,}:?$"#, options: .regularExpression) != nil }) {
                flushParagraph()
                var rows = [headings]
                index += 2
                while index < lines.count, lines[index].contains("|") {
                    rows.append(tableCells(lines[index]))
                    index += 1
                }
                blocks.append(.table(rows))
                continue
            }
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

private func tableCells(_ line: String) -> [String] {
    line.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "|"))
        .components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
}

private struct ArtifactTemplate {
    let name: String
    let prompt: String
    init?(directive: String) {
        guard directive.hasPrefix("::artifact-template{"), directive.hasSuffix("}") else { return nil }
        var attributes: [String:String] = [:]
        for match in directive.matches(of: /([a-z_]+)="([^"]*)"/) {
            attributes[String(match.1)] = String(match.2)
        }
        guard let skill = attributes["skill_name"], skill.wholeMatch(of: /artifact-template-[A-Za-z0-9_-]+/) != nil,
              let display = attributes["display_name"], !display.isEmpty,
              let directory = attributes["skill_directory"], directory.hasPrefix("/") || directory.contains(":\\"),
              let kind = attributes["artifact_kind"] else { return nil }
        let kinds = ["document":"document", "presentation":"presentation", "spreadsheet":"spreadsheet",
                     "site":"Site", "google-docs":"Google Doc", "google-slides":"Google Slides presentation",
                     "google-sheets":"Google Sheet", "image":"image", "email":"email", "slack":"Slack message"]
        guard let artifact = kinds[kind] else { return nil }
        self.name = display
        prompt = "Use $\(skill) to create a new \(artifact) about…"
    }
}
