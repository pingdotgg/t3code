import Foundation

/// A small block-level Markdown model used by chat messages.
///
/// Foundation already provides a strong inline Markdown parser. This layer only
/// separates the block structures that `Text` otherwise flattens, keeping chat
/// rendering native and dependency-free.
struct MarkdownDocument: Equatable, Sendable {
    let blocks: [MarkdownBlock]

    init(parsing source: String) {
        var parser = MarkdownBlockParser(source: source)
        blocks = parser.parse()
    }

    fileprivate init(blocks: [MarkdownBlock]) {
        self.blocks = blocks
    }
}

indirect enum MarkdownBlock: Equatable, Sendable {
    case paragraph(String)
    case heading(level: Int, text: String)
    case unorderedList([MarkdownListItem])
    case orderedList(start: Int, items: [MarkdownListItem])
    case blockquote(MarkdownDocument)
    case table(MarkdownTable)
    case codeBlock(language: String?, code: String)
    case thematicBreak
}

struct MarkdownTable: Equatable, Sendable {
    let header: [String]
    let alignments: [MarkdownTableAlignment]
    let rows: [[String]]
}

enum MarkdownTableAlignment: Equatable, Sendable {
    case natural
    case leading
    case center
    case trailing
}

struct MarkdownListItem: Equatable, Sendable {
    let task: MarkdownTaskState?
    let blocks: [MarkdownBlock]
}

enum MarkdownTaskState: Equatable, Sendable {
    case incomplete
    case complete
}

private struct MarkdownBlockParser {
    private let lines: [String]
    private var index = 0

    init(source: String) {
        let normalized = source
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        lines = normalized.components(separatedBy: "\n")
    }

    mutating func parse() -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []

        while index < lines.count {
            if lines[index].isMarkdownBlank {
                index += 1
                continue
            }

            if let fence = fenceMarker(in: lines[index]) {
                blocks.append(parseCodeBlock(opening: fence))
                continue
            }

            if let heading = atxHeading(in: lines[index]) {
                blocks.append(.heading(level: heading.level, text: heading.text))
                index += 1
                continue
            }

            if let table = tableOpening(at: index) {
                blocks.append(parseTable(opening: table))
                continue
            }

            if let level = setextHeadingLevel(after: index) {
                blocks.append(.heading(level: level, text: lines[index].markdownTrimmed))
                index += 2
                continue
            }

            if blockquoteContent(in: lines[index]) != nil {
                blocks.append(parseBlockquote())
                continue
            }

            if let marker = listMarker(in: lines[index]) {
                blocks.append(parseList(opening: marker))
                continue
            }

            if isThematicBreak(lines[index]) {
                blocks.append(.thematicBreak)
                index += 1
                continue
            }

            blocks.append(parseParagraph())
        }

        return blocks
    }

    private mutating func parseCodeBlock(opening: FenceMarker) -> MarkdownBlock {
        index += 1
        var codeLines: [String] = []

        while index < lines.count {
            let line = lines[index]
            if isClosingFence(line, matching: opening) {
                index += 1
                break
            }
            codeLines.append(line)
            index += 1
        }

        return .codeBlock(language: opening.language, code: codeLines.joined(separator: "\n"))
    }

    private mutating func parseBlockquote() -> MarkdownBlock {
        var quotedLines: [String] = []

        while index < lines.count, let content = blockquoteContent(in: lines[index]) {
            quotedLines.append(content)
            index += 1
        }

        var parser = MarkdownBlockParser(source: quotedLines.joined(separator: "\n"))
        return .blockquote(MarkdownDocument(blocks: parser.parse()))
    }

    private mutating func parseTable(opening: TableOpening) -> MarkdownBlock {
        index += 2
        var rows: [[String]] = []

        while index < lines.count,
              !lines[index].isMarkdownBlank,
              let cells = tableCells(in: lines[index]) {
            var normalized = Array(cells.prefix(opening.header.count))
            if normalized.count < opening.header.count {
                normalized.append(
                    contentsOf: repeatElement(
                        "",
                        count: opening.header.count - normalized.count
                    )
                )
            }
            rows.append(normalized)
            index += 1
        }

        return .table(
            MarkdownTable(
                header: opening.header,
                alignments: opening.alignments,
                rows: rows
            )
        )
    }

    private mutating func parseList(opening: ListMarker) -> MarkdownBlock {
        var items: [MarkdownListItem] = []
        let ordered = opening.number != nil

        while index < lines.count,
              let marker = listMarker(in: lines[index]),
              marker.indent == opening.indent,
              (marker.number != nil) == ordered {
            index += 1
            var itemLines = [marker.content]

            while index < lines.count {
                let line = lines[index]

                if line.isMarkdownBlank {
                    let next = nextNonblankLine(after: index)
                    guard let next else {
                        index = lines.count
                        break
                    }

                    if let nextMarker = listMarker(in: lines[next]),
                       nextMarker.indent == opening.indent,
                       (nextMarker.number != nil) == ordered {
                        index = next
                        break
                    }

                    if lines[next].markdownLeadingSpaces > opening.indent {
                        itemLines.append("")
                        index += 1
                        continue
                    }

                    index = next
                    break
                }

                if let nextMarker = listMarker(in: line), nextMarker.indent == opening.indent {
                    break
                }

                let leadingSpaces = line.markdownLeadingSpaces
                if leadingSpaces > opening.indent {
                    let continuationIndent = min(
                        leadingSpaces,
                        max(opening.indent + 2, marker.contentIndent)
                    )
                    itemLines.append(line.droppingLeadingSpaces(continuationIndent))
                    index += 1
                    continue
                }

                if isBlockStarter(line) {
                    break
                }

                // CommonMark permits a paragraph continuation without indentation.
                itemLines.append(line)
                index += 1
            }

            let task = taskState(in: itemLines.first ?? "")
            if task != nil, !itemLines.isEmpty {
                itemLines[0] = removingTaskMarker(from: itemLines[0])
            }
            var itemParser = MarkdownBlockParser(source: itemLines.joined(separator: "\n"))
            items.append(MarkdownListItem(task: task, blocks: itemParser.parse()))

            guard index < lines.count,
                  let nextMarker = listMarker(in: lines[index]),
                  nextMarker.indent == opening.indent,
                  (nextMarker.number != nil) == ordered else {
                break
            }
        }

        if let start = opening.number {
            return .orderedList(start: start, items: items)
        }
        return .unorderedList(items)
    }

    private mutating func parseParagraph() -> MarkdownBlock {
        var paragraphLines: [String] = []

        while index < lines.count, !lines[index].isMarkdownBlank {
            if !paragraphLines.isEmpty,
               (isBlockStarter(lines[index]) || tableOpening(at: index) != nil) {
                break
            }
            paragraphLines.append(lines[index].markdownTrimmedTrailing)
            index += 1
        }

        return .paragraph(paragraphLines.joined(separator: "\n"))
    }

    private func tableOpening(at position: Int) -> TableOpening? {
        guard position + 1 < lines.count,
              let header = tableCells(in: lines[position]),
              let delimiters = tableCells(in: lines[position + 1]),
              header.count == delimiters.count,
              !header.isEmpty else {
            return nil
        }

        let alignments = delimiters.compactMap(tableAlignment(in:))
        guard alignments.count == delimiters.count else { return nil }
        return TableOpening(header: header, alignments: alignments)
    }

    private func tableAlignment(in source: String) -> MarkdownTableAlignment? {
        var marker = source.markdownTrimmed
        let hasLeadingColon = marker.first == ":"
        let hasTrailingColon = marker.last == ":"
        if hasLeadingColon { marker.removeFirst() }
        if hasTrailingColon, !marker.isEmpty { marker.removeLast() }
        guard marker.count >= 3, marker.allSatisfy({ $0 == "-" }) else { return nil }
        return switch (hasLeadingColon, hasTrailingColon) {
        case (true, true): .center
        case (true, false): .leading
        case (false, true): .trailing
        case (false, false): .natural
        }
    }

    /// Splits a GFM table row while preserving escapes for Foundation's inline parser.
    /// Pipes inside code spans or escaped with a backslash remain cell content.
    private func tableCells(in line: String) -> [String]? {
        let source = line.markdownTrimmed
        guard !source.isEmpty else { return nil }

        var cells = [String]()
        var cell = ""
        var codeFenceLength: Int?
        var foundSeparator = false

        let characters = Array(source)
        var cursor = 0
        while cursor < characters.count {
            let character = characters[cursor]
            if character == "\\", cursor + 1 < characters.count {
                cell.append(character)
                cell.append(characters[cursor + 1])
                cursor += 2
                continue
            }
            if character == "`" {
                var runEnd = cursor
                while runEnd < characters.count, characters[runEnd] == "`" {
                    runEnd += 1
                }
                let runLength = runEnd - cursor
                for _ in cursor..<runEnd { cell.append("`") }
                if codeFenceLength == nil {
                    codeFenceLength = runLength
                } else if codeFenceLength == runLength {
                    codeFenceLength = nil
                }
                cursor = runEnd
                continue
            }
            if character == "|", codeFenceLength == nil {
                cells.append(cell.markdownTrimmed)
                cell = ""
                foundSeparator = true
            } else {
                cell.append(character)
            }
            cursor += 1
        }
        cells.append(cell.markdownTrimmed)

        guard foundSeparator else { return nil }
        if source.first == "|", cells.first?.isEmpty == true {
            cells.removeFirst()
        }
        if source.last == "|", cells.last?.isEmpty == true {
            cells.removeLast()
        }
        return cells
    }

    private func isBlockStarter(_ line: String) -> Bool {
        fenceMarker(in: line) != nil
            || atxHeading(in: line) != nil
            || blockquoteContent(in: line) != nil
            || listMarker(in: line) != nil
            || isThematicBreak(line)
    }

    private func nextNonblankLine(after position: Int) -> Int? {
        var candidate = position + 1
        while candidate < lines.count {
            if !lines[candidate].isMarkdownBlank {
                return candidate
            }
            candidate += 1
        }
        return nil
    }

    private func atxHeading(in line: String) -> (level: Int, text: String)? {
        let characters = Array(line)
        let indent = min(line.markdownLeadingSpaces, characters.count)
        guard indent <= 3, indent < characters.count, characters[indent] == "#" else {
            return nil
        }

        var cursor = indent
        while cursor < characters.count, characters[cursor] == "#" {
            cursor += 1
        }
        let level = cursor - indent
        guard level <= 6,
              cursor == characters.count || characters[cursor].isMarkdownWhitespace else {
            return nil
        }

        while cursor < characters.count, characters[cursor].isMarkdownWhitespace {
            cursor += 1
        }
        var content = String(characters[cursor..<characters.endIndex]).markdownTrimmed
        if let closingHashes = content.range(
            of: #"[ \t]+#+[ \t]*$"#,
            options: .regularExpression
        ) {
            content.removeSubrange(closingHashes)
            content = content.markdownTrimmedTrailing
        }
        return (level, content)
    }

    private func setextHeadingLevel(after position: Int) -> Int? {
        guard position + 1 < lines.count, !lines[position].isMarkdownBlank else {
            return nil
        }
        let underline = lines[position + 1].markdownTrimmed
        guard !underline.isEmpty else { return nil }
        if underline.allSatisfy({ $0 == "=" }) {
            return 1
        }
        if underline.allSatisfy({ $0 == "-" }) {
            return 2
        }
        return nil
    }

    private func blockquoteContent(in line: String) -> String? {
        let characters = Array(line)
        let indent = min(line.markdownLeadingSpaces, characters.count)
        guard indent <= 3, indent < characters.count, characters[indent] == ">" else {
            return nil
        }
        var cursor = indent + 1
        if cursor < characters.count, characters[cursor].isMarkdownWhitespace {
            cursor += 1
        }
        return cursor < characters.count ? String(characters[cursor...]) : ""
    }

    private func listMarker(in line: String) -> ListMarker? {
        let characters = Array(line)
        let indent = min(line.markdownLeadingSpaces, characters.count)
        guard indent <= 3, indent < characters.count else { return nil }

        var cursor = indent
        var number: Int?

        if ["-", "+", "*"].contains(characters[cursor]) {
            cursor += 1
        } else if characters[cursor].isNumber {
            let numberStart = cursor
            while cursor < characters.count,
                  characters[cursor].isNumber,
                  cursor - numberStart < 9 {
                cursor += 1
            }
            guard cursor > numberStart,
                  cursor < characters.count,
                  characters[cursor] == "." || characters[cursor] == ")",
                  let parsedNumber = Int(String(characters[numberStart..<cursor])) else {
                return nil
            }
            number = parsedNumber
            cursor += 1
        } else {
            return nil
        }

        guard cursor < characters.count, characters[cursor].isMarkdownWhitespace else {
            return nil
        }
        while cursor < characters.count, characters[cursor].isMarkdownWhitespace {
            cursor += 1
        }

        return ListMarker(
            indent: indent,
            contentIndent: cursor,
            number: number,
            content: cursor < characters.count ? String(characters[cursor...]) : ""
        )
    }

    private func taskState(in line: String) -> MarkdownTaskState? {
        let characters = Array(line)
        guard characters.count >= 3,
              characters[0] == "[",
              characters[2] == "]",
              [" ", "x", "X"].contains(characters[1]),
              characters.count == 3 || characters[3].isMarkdownWhitespace else {
            return nil
        }
        return characters[1] == " " ? .incomplete : .complete
    }

    private func removingTaskMarker(from line: String) -> String {
        let characters = Array(line)
        var cursor = min(3, characters.count)
        while cursor < characters.count, characters[cursor].isMarkdownWhitespace {
            cursor += 1
        }
        return cursor < characters.count ? String(characters[cursor...]) : ""
    }

    private func isThematicBreak(_ line: String) -> Bool {
        let trimmed = line.markdownTrimmed
        guard let marker = trimmed.first, ["-", "_", "*"].contains(marker) else {
            return false
        }
        let visible = trimmed.filter { !$0.isMarkdownWhitespace }
        return visible.count >= 3 && visible.allSatisfy { $0 == marker }
    }

    private func fenceMarker(in line: String) -> FenceMarker? {
        let characters = Array(line)
        let indent = min(line.markdownLeadingSpaces, characters.count)
        guard indent <= 3,
              indent < characters.count,
              characters[indent] == "`" || characters[indent] == "~" else {
            return nil
        }

        let character = characters[indent]
        var cursor = indent
        while cursor < characters.count, characters[cursor] == character {
            cursor += 1
        }
        let length = cursor - indent
        guard length >= 3 else { return nil }

        let info = cursor < characters.count
            ? String(characters[cursor...]).markdownTrimmed
            : ""
        guard character != "`" || !info.contains("`") else { return nil }
        return FenceMarker(
            character: character,
            length: length,
            language: info.split(whereSeparator: { $0.isWhitespace }).first.map(String.init)
        )
    }

    private func isClosingFence(_ line: String, matching opening: FenceMarker) -> Bool {
        let characters = Array(line)
        let indent = min(line.markdownLeadingSpaces, characters.count)
        guard indent <= 3,
              indent < characters.count,
              characters[indent] == opening.character else {
            return false
        }

        var cursor = indent
        while cursor < characters.count, characters[cursor] == opening.character {
            cursor += 1
        }
        guard cursor - indent >= opening.length else { return false }
        return characters[cursor..<characters.endIndex].allSatisfy { $0.isMarkdownWhitespace }
    }
}

private struct FenceMarker {
    let character: Character
    let length: Int
    let language: String?
}

private struct ListMarker {
    let indent: Int
    let contentIndent: Int
    let number: Int?
    let content: String
}

private struct TableOpening {
    let header: [String]
    let alignments: [MarkdownTableAlignment]
}

private extension String {
    var isMarkdownBlank: Bool {
        allSatisfy { $0.isMarkdownWhitespace }
    }

    var markdownLeadingSpaces: Int {
        prefix { $0 == " " }.count
    }

    var markdownTrimmed: String {
        trimmingCharacters(in: .whitespaces)
    }

    var markdownTrimmedTrailing: String {
        replacingOccurrences(of: #"[ \t]+$"#, with: "", options: .regularExpression)
    }

    func droppingLeadingSpaces(_ count: Int) -> String {
        String(dropFirst(Swift.min(count, markdownLeadingSpaces)))
    }
}

private extension Character {
    var isMarkdownWhitespace: Bool {
        self == " " || self == "\t"
    }
}
