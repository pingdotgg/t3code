import Foundation
import SwiftUI

// Precomputed row view-models for DiffReviewView. Built once when a file's
// diff loads — never do pairing/token math in SwiftUI `body`.

enum DiffZoom {
    static let minFactor = 0.6
    static let maxFactor = 2.0
    static let defaultFactor = 1.0
    static let step = 0.1
    static let appStorageKey = "diffPanelZoomFactor"

    private static let contentBaseSize: CGFloat = 13
    private static let captionBaseSize: CGFloat = 10
    private static let gutterBaseWidth: CGFloat = 40
    /// Indent past the dual gutter so soft-wrapped continuations hang under code.
    static let codeLeadingPadding: CGFloat = 6

    static func clamp(_ factor: Double) -> Double {
        let rounded = (factor * 100).rounded() / 100
        return min(maxFactor, max(minFactor, rounded))
    }

    static func stepped(_ factor: Double, by delta: Double) -> Double {
        let next = ((factor + delta) / step).rounded() * step
        return clamp(next)
    }

    static func contentFontSize(for factor: Double) -> CGFloat {
        contentBaseSize * CGFloat(clamp(factor))
    }

    static func captionFontSize(for factor: Double) -> CGFloat {
        captionBaseSize * CGFloat(clamp(factor))
    }

    static func gutterWidth(for factor: Double) -> CGFloat {
        gutterBaseWidth * CGFloat(clamp(factor))
    }
}

/// One precomputed unified-view row.
struct UnifiedDiffRow: Identifiable, Sendable {
    enum Kind: Sendable {
        case hunkHeader
        case line
    }

    let id: String
    let kind: Kind
    /// Hunk header text, or empty for line rows.
    let header: String
    let lineKind: DiffLineKind
    let text: String
    let oldNumber: Int?
    let newNumber: Int?
    /// Intraline highlight spans when this line was paired; nil = flat tint.
    let intraline: [IntralineSpan]?
    let syntax: [SyntaxSpan]
    let attributed: AttributedString
}

/// One precomputed side-by-side row (aligned old | new).
struct SideBySideDiffRow: Identifiable, Sendable {
    enum Kind: Sendable {
        case hunkHeader
        case pair
    }

    let id: String
    let kind: Kind
    let header: String

    // Old side (nil = filler blank).
    let oldText: String?
    let oldNumber: Int?
    let oldLineKind: DiffLineKind?
    let oldIntraline: [IntralineSpan]?
    let oldSyntax: [SyntaxSpan]
    let oldAttributed: AttributedString?

    // New side.
    let newText: String?
    let newNumber: Int?
    let newLineKind: DiffLineKind?
    let newIntraline: [IntralineSpan]?
    let newSyntax: [SyntaxSpan]
    let newAttributed: AttributedString?
}

/// Builds diff text attributes off the render path. Syntax and intraline spans
/// are both partitions of the same string, so their attributes can be merged
/// by walking their interval boundaries instead of visiting every character.
enum DiffTextBuilder {
    static func attributedLine(
        text: String,
        lineKind: DiffLineKind,
        intraline: [IntralineSpan]?,
        syntax: [SyntaxSpan]
    ) -> AttributedString {
        guard !text.isEmpty else { return AttributedString() }

        let syntaxSpans = syntax.isEmpty
            ? SyntaxTint.tokenize(text, language: .plain)
            : syntax
        let syntaxIntervals = makeSyntaxIntervals(text: text, spans: syntaxSpans)
        let changeIntervals: [ChangeInterval]
        if let intraline, !intraline.isEmpty {
            changeIntervals = makeChangeIntervals(text: text, spans: intraline)
        } else {
            changeIntervals = [
                ChangeInterval(
                    range: text.startIndex..<text.endIndex,
                    isChanged: false)
            ]
        }

        var result = AttributedString()
        var syntaxIndex = 0
        var changeIndex = 0

        while syntaxIndex < syntaxIntervals.count && changeIndex < changeIntervals.count {
            let syntaxInterval = syntaxIntervals[syntaxIndex]
            let changeInterval = changeIntervals[changeIndex]
            let lowerBound = max(
                syntaxInterval.range.lowerBound,
                changeInterval.range.lowerBound)
            let upperBound = min(
                syntaxInterval.range.upperBound,
                changeInterval.range.upperBound)

            if lowerBound < upperBound {
                var piece = AttributedString(String(text[lowerBound..<upperBound]))
                if changeInterval.isChanged {
                    piece.backgroundColor = highlightColor(for: lineKind)
                }
                if let color = syntaxColor(syntaxInterval.kind, lineKind: lineKind) {
                    piece.foregroundColor = color
                }
                result.append(piece)
            }

            if syntaxInterval.range.upperBound <= changeInterval.range.upperBound {
                syntaxIndex += 1
            }
            if changeInterval.range.upperBound <= syntaxInterval.range.upperBound {
                changeIndex += 1
            }
        }

        // The production spans cover the whole line. Keep this fallback for
        // malformed/partial input so the attributed value never loses text.
        return result.characters.isEmpty ? AttributedString(text) : result
    }

    private struct SyntaxInterval {
        let range: Range<String.Index>
        let kind: SyntaxKind
    }

    private struct ChangeInterval {
        let range: Range<String.Index>
        let isChanged: Bool
    }

    private static func makeSyntaxIntervals(
        text: String,
        spans: [SyntaxSpan]
    ) -> [SyntaxInterval] {
        var intervals: [SyntaxInterval] = []
        intervals.reserveCapacity(spans.count + 1)
        var lowerBound = text.startIndex

        for span in spans {
            guard lowerBound < text.endIndex else { break }
            let upperBound = text.index(
                lowerBound,
                offsetBy: span.text.count,
                limitedBy: text.endIndex) ?? text.endIndex
            if lowerBound < upperBound {
                intervals.append(
                    SyntaxInterval(range: lowerBound..<upperBound, kind: span.kind))
            }
            lowerBound = upperBound
        }

        if lowerBound < text.endIndex {
            intervals.append(
                SyntaxInterval(range: lowerBound..<text.endIndex, kind: .plain))
        }
        return intervals
    }

    private static func makeChangeIntervals(
        text: String,
        spans: [IntralineSpan]
    ) -> [ChangeInterval] {
        var intervals: [ChangeInterval] = []
        intervals.reserveCapacity(spans.count + 1)
        var lowerBound = text.startIndex

        for span in spans {
            guard lowerBound < text.endIndex else { break }
            let upperBound = text.index(
                lowerBound,
                offsetBy: span.text.count,
                limitedBy: text.endIndex) ?? text.endIndex
            if lowerBound < upperBound {
                intervals.append(
                    ChangeInterval(range: lowerBound..<upperBound, isChanged: span.isChanged))
            }
            lowerBound = upperBound
        }

        if lowerBound < text.endIndex {
            intervals.append(
                ChangeInterval(range: lowerBound..<text.endIndex, isChanged: false))
        }
        return intervals
    }

    private static func highlightColor(for lineKind: DiffLineKind) -> Color {
        switch lineKind {
        case .addition: Color.green.opacity(0.28)
        case .deletion: Color.red.opacity(0.28)
        case .context: Color.clear
        }
    }

    /// Subtle syntax colors that stay readable over add/del row tints.
    private static func syntaxColor(_ kind: SyntaxKind, lineKind: DiffLineKind) -> Color? {
        // On add/del rows, keep contrast by using slightly muted colors.
        let muted = lineKind != .context
        switch kind {
        case .plain:
            return nil
        case .keyword:
            return muted
                ? Color.purple.opacity(0.85)
                : Color(red: 0.56, green: 0.25, blue: 0.68)
        case .string:
            return muted
                ? Color.red.opacity(0.75)
                : Color(red: 0.72, green: 0.22, blue: 0.25)
        case .comment:
            return Color.secondary.opacity(muted ? 0.9 : 1)
        case .number:
            return muted
                ? Color.blue.opacity(0.8)
                : Color(red: 0.15, green: 0.35, blue: 0.70)
        }
    }
}

enum DiffPresentation {
    /// Build unified rows for a file off the render path.
    static func buildUnifiedRows(for file: DiffFile) throws -> [UnifiedDiffRow] {
        let startedAt = PerfLog.now()
        let language = SyntaxLanguage.language(forPath: file.path)
        var rows: [UnifiedDiffRow] = []
        rows.reserveCapacity(file.hunks.reduce(0) { $0 + $1.lines.count + 1 })
        defer {
            PerfLog.event(
                "diff.unifiedRows",
                ms: PerfLog.elapsedMilliseconds(since: startedAt),
                details: "file=\(file.path) rows=\(rows.count)")
        }

        for (hunkIndex, hunk) in file.hunks.enumerated() {
            try Task.checkCancellation()
            rows.append(
                UnifiedDiffRow(
                    id: "h\(hunkIndex)-hdr",
                    kind: .hunkHeader,
                    header: hunk.header,
                    lineKind: .context,
                    text: "",
                    oldNumber: nil,
                    newNumber: nil,
                    intraline: nil,
                    syntax: [],
                    attributed: AttributedString()
                ))

            let paired = IntralineDiff.pairHunkLines(hunk.lines)
            for (lineIndex, line) in hunk.lines.enumerated() {
                try Task.checkCancellation()
                let spans = paired[lineIndex]
                let syntax = SyntaxTint.tokenize(line.text, language: language)
                let attributed = DiffTextBuilder.attributedLine(
                    text: line.text,
                    lineKind: line.kind,
                    intraline: spans,
                    syntax: syntax)
                rows.append(
                    UnifiedDiffRow(
                        id: "h\(hunkIndex)-l\(lineIndex)",
                        kind: .line,
                        header: "",
                        lineKind: line.kind,
                        text: line.text,
                        oldNumber: line.oldNumber,
                        newNumber: line.newNumber,
                        intraline: spans,
                        syntax: syntax,
                        attributed: attributed
                    ))
            }
        }
        return rows
    }

    /// Build side-by-side rows: pair deletions with additions inside each hunk.
    static func buildSideBySideRows(for file: DiffFile) throws -> [SideBySideDiffRow] {
        let startedAt = PerfLog.now()
        let language = SyntaxLanguage.language(forPath: file.path)
        var rows: [SideBySideDiffRow] = []
        defer {
            PerfLog.event(
                "diff.sideBySideRows",
                ms: PerfLog.elapsedMilliseconds(since: startedAt),
                details: "file=\(file.path) rows=\(rows.count)")
        }

        for (hunkIndex, hunk) in file.hunks.enumerated() {
            try Task.checkCancellation()
            rows.append(
                SideBySideDiffRow(
                    id: "s\(hunkIndex)-hdr",
                    kind: .hunkHeader,
                    header: hunk.header,
                    oldText: nil, oldNumber: nil, oldLineKind: nil, oldIntraline: nil,
                    oldSyntax: [], oldAttributed: nil,
                    newText: nil, newNumber: nil, newLineKind: nil, newIntraline: nil,
                    newSyntax: [], newAttributed: nil
                ))

            let paired = IntralineDiff.pairHunkLines(hunk.lines)
            var index = 0
            let lines = hunk.lines
            while index < lines.count {
                try Task.checkCancellation()
                let line = lines[index]
                switch line.kind {
                case .context:
                    let syntax = SyntaxTint.tokenize(line.text, language: language)
                    let attributed = DiffTextBuilder.attributedLine(
                        text: line.text,
                        lineKind: .context,
                        intraline: nil,
                        syntax: syntax)
                    rows.append(
                        SideBySideDiffRow(
                            id: "s\(hunkIndex)-c\(index)",
                            kind: .pair,
                            header: "",
                            oldText: line.text,
                            oldNumber: line.oldNumber,
                            oldLineKind: .context,
                            oldIntraline: nil,
                            oldSyntax: syntax,
                            oldAttributed: attributed,
                            newText: line.text,
                            newNumber: line.newNumber,
                            newLineKind: .context,
                            newIntraline: nil,
                            newSyntax: syntax,
                            newAttributed: attributed
                        ))
                    index += 1

                case .deletion, .addition:
                    // Collect a delete-run then add-run (or vice versa) and zip.
                    var deletions: [(Int, DiffLine)] = []
                    var additions: [(Int, DiffLine)] = []
                    var j = index
                    while j < lines.count && lines[j].kind == .deletion {
                        deletions.append((j, lines[j]))
                        j += 1
                    }
                    while j < lines.count && lines[j].kind == .addition {
                        additions.append((j, lines[j]))
                        j += 1
                    }
                    // If we started on addition with no preceding deletion in this block.
                    if deletions.isEmpty && line.kind == .addition {
                        while j < lines.count && lines[j].kind == .addition {
                            additions.append((j, lines[j]))
                            j += 1
                        }
                        while j < lines.count && lines[j].kind == .deletion {
                            deletions.append((j, lines[j]))
                            j += 1
                        }
                    }

                    let count = max(deletions.count, additions.count)
                    if count == 0 {
                        index += 1
                        continue
                    }
                    for k in 0..<count {
                        try Task.checkCancellation()
                        let del = k < deletions.count ? deletions[k] : nil
                        let add = k < additions.count ? additions[k] : nil
                        let oldSyntax =
                            del.map { SyntaxTint.tokenize($0.1.text, language: language) } ?? []
                        let newSyntax =
                            add.map { SyntaxTint.tokenize($0.1.text, language: language) } ?? []
                        let oldIntraline = del.flatMap { paired[$0.0] }
                        let newIntraline = add.flatMap { paired[$0.0] }
                        let oldAttributed = del.map {
                            DiffTextBuilder.attributedLine(
                                text: $0.1.text,
                                lineKind: .deletion,
                                intraline: oldIntraline,
                                syntax: oldSyntax)
                        }
                        let newAttributed = add.map {
                            DiffTextBuilder.attributedLine(
                                text: $0.1.text,
                                lineKind: .addition,
                                intraline: newIntraline,
                                syntax: newSyntax)
                        }
                        rows.append(
                            SideBySideDiffRow(
                                id: "s\(hunkIndex)-p\(index)-\(k)",
                                kind: .pair,
                                header: "",
                                oldText: del?.1.text,
                                oldNumber: del?.1.oldNumber,
                                oldLineKind: del.map { _ in .deletion },
                                oldIntraline: oldIntraline,
                                oldSyntax: oldSyntax,
                                oldAttributed: oldAttributed,
                                newText: add?.1.text,
                                newNumber: add?.1.newNumber,
                                newLineKind: add.map { _ in .addition },
                                newIntraline: newIntraline,
                                newSyntax: newSyntax,
                                newAttributed: newAttributed
                            ))
                    }
                    index = j
                }
            }
        }
        return rows
    }

    static func additionCount(in file: DiffFile) -> Int {
        file.hunks.reduce(0) { count, hunk in
            count + hunk.lines.filter {
                if case .addition = $0.kind { return true }
                return false
            }.count
        }
    }

    static func deletionCount(in file: DiffFile) -> Int {
        file.hunks.reduce(0) { count, hunk in
            count + hunk.lines.filter {
                if case .deletion = $0.kind { return true }
                return false
            }.count
        }
    }

    static func aggregateCounts(in files: [DiffFile]) -> (additions: Int, deletions: Int) {
        var add = 0
        var del = 0
        for file in files {
            add += additionCount(in: file)
            del += deletionCount(in: file)
        }
        return (add, del)
    }
}
