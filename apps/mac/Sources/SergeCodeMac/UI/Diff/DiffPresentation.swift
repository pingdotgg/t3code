import Foundation

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

    // New side.
    let newText: String?
    let newNumber: Int?
    let newLineKind: DiffLineKind?
    let newIntraline: [IntralineSpan]?
    let newSyntax: [SyntaxSpan]
}

enum DiffPresentation {
    /// Build unified rows for a file off the render path.
    static func buildUnifiedRows(for file: DiffFile) -> [UnifiedDiffRow] {
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
                    syntax: []
                ))

            let paired = IntralineDiff.pairHunkLines(hunk.lines)
            for (lineIndex, line) in hunk.lines.enumerated() {
                let spans = paired[lineIndex]
                let syntax = SyntaxTint.tokenize(line.text, language: language)
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
                        syntax: syntax
                    ))
            }
        }
        return rows
    }

    /// Build side-by-side rows: pair deletions with additions inside each hunk.
    static func buildSideBySideRows(for file: DiffFile) -> [SideBySideDiffRow] {
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
            rows.append(
                SideBySideDiffRow(
                    id: "s\(hunkIndex)-hdr",
                    kind: .hunkHeader,
                    header: hunk.header,
                    oldText: nil, oldNumber: nil, oldLineKind: nil, oldIntraline: nil,
                    oldSyntax: [],
                    newText: nil, newNumber: nil, newLineKind: nil, newIntraline: nil,
                    newSyntax: []
                ))

            let paired = IntralineDiff.pairHunkLines(hunk.lines)
            var index = 0
            let lines = hunk.lines
            while index < lines.count {
                let line = lines[index]
                switch line.kind {
                case .context:
                    let syntax = SyntaxTint.tokenize(line.text, language: language)
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
                            newText: line.text,
                            newNumber: line.newNumber,
                            newLineKind: .context,
                            newIntraline: nil,
                            newSyntax: syntax
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
                        let del = k < deletions.count ? deletions[k] : nil
                        let add = k < additions.count ? additions[k] : nil
                        let oldSyntax =
                            del.map { SyntaxTint.tokenize($0.1.text, language: language) } ?? []
                        let newSyntax =
                            add.map { SyntaxTint.tokenize($0.1.text, language: language) } ?? []
                        rows.append(
                            SideBySideDiffRow(
                                id: "s\(hunkIndex)-p\(index)-\(k)",
                                kind: .pair,
                                header: "",
                                oldText: del?.1.text,
                                oldNumber: del?.1.oldNumber,
                                oldLineKind: del.map { _ in .deletion },
                                oldIntraline: del.flatMap { paired[$0.0] },
                                oldSyntax: oldSyntax,
                                newText: add?.1.text,
                                newNumber: add?.1.newNumber,
                                newLineKind: add.map { _ in .addition },
                                newIntraline: add.flatMap { paired[$0.0] },
                                newSyntax: newSyntax
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
