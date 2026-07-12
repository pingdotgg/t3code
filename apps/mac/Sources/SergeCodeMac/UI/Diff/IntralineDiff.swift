import Foundation

// Word/token-level diff for pairing adjacent deletion/addition runs inside a
// hunk. Pure and Sendable so heavy diffs can be computed off the main actor.

/// One token span within a line, flagged as equal or changed relative to its
/// paired counterpart.
public struct IntralineSpan: Equatable, Sendable, Hashable {
    public var text: String
    public var isChanged: Bool

    public init(text: String, isChanged: Bool) {
        self.text = text
        self.isChanged = isChanged
    }
}

/// Result of pairing a deletion line with an addition line.
public struct IntralinePair: Equatable, Sendable {
    public var deletion: [IntralineSpan]
    public var addition: [IntralineSpan]

    public init(deletion: [IntralineSpan], addition: [IntralineSpan]) {
        self.deletion = deletion
        self.addition = addition
    }
}

public enum IntralineDiff: Sendable {
    static let maxIntralineLineLength = 2000
    static let maxLCSTableCells = 250_000

    /// Split into word and separator tokens. Separators (whitespace +
    /// punctuation runs) are kept so the reconstructed line is exact.
    public static func tokenize(_ text: String) -> [String] {
        guard !text.isEmpty else { return [] }
        var tokens: [String] = []
        var current = ""
        var currentIsWord: Bool?

        for ch in text {
            let isWord = ch.isLetter || ch.isNumber || ch == "_"
            if let kind = currentIsWord {
                if kind == isWord {
                    current.append(ch)
                } else {
                    tokens.append(current)
                    current = String(ch)
                    currentIsWord = isWord
                }
            } else {
                current = String(ch)
                currentIsWord = isWord
            }
        }
        if !current.isEmpty { tokens.append(current) }
        return tokens
    }

    /// Token-level LCS diff: spans marked `isChanged` where tokens diverge.
    public static func diffTokens(old: String, new: String) -> IntralinePair {
        let oldTokens = tokenize(old)
        let newTokens = tokenize(new)
        if oldTokens.isEmpty && newTokens.isEmpty {
            return IntralinePair(deletion: [], addition: [])
        }
        if oldTokens == newTokens {
            return IntralinePair(
                deletion: oldTokens.map { IntralineSpan(text: $0, isChanged: false) },
                addition: newTokens.map { IntralineSpan(text: $0, isChanged: false) })
        }
        if old.count > maxIntralineLineLength
            || new.count > maxIntralineLineLength
            || oldTokens.count * newTokens.count > maxLCSTableCells
        {
            return IntralinePair(
                deletion: [IntralineSpan(text: old, isChanged: true)],
                addition: [IntralineSpan(text: new, isChanged: true)])
        }

        let lcs = longestCommonSubsequence(oldTokens, newTokens)
        return IntralinePair(
            deletion: mark(tokens: oldTokens, lcs: lcs),
            addition: mark(tokens: newTokens, lcs: lcs)
        )
    }

    /// Within a hunk's ordered lines, pair the i-th consecutive deletion run
    /// with the i-th consecutive addition run (Myers-style edit-script pairing
    /// simplified to run pairing). Returns per-line span arrays keyed by the
    /// line's index in `lines`. Unpaired lines are absent from the map.
    public static func pairHunkLines(_ lines: [DiffLine]) -> [Int: [IntralineSpan]] {
        // Collect runs of pure deletions and pure additions, preserving order.
        // A "run" is a maximal contiguous sequence of the same non-context kind.
        struct Run {
            var kind: DiffLineKind
            var indices: [Int]
        }

        var runs: [Run] = []
        for (index, line) in lines.enumerated() {
            switch line.kind {
            case .context:
                continue
            case .deletion, .addition:
                if var last = runs.last, last.kind == line.kind,
                    last.indices.last.map({ $0 + 1 == index }) == true
                {
                    last.indices.append(index)
                    runs[runs.count - 1] = last
                } else {
                    runs.append(Run(kind: line.kind, indices: [index]))
                }
            }
        }

        // Group into delete-run / add-run pairs when they sit adjacent
        // (delete run followed by add run, classic unified-diff block).
        var deletionRuns: [[Int]] = []
        var additionRuns: [[Int]] = []
        var i = 0
        while i < runs.count {
            let run = runs[i]
            if run.kind == .deletion,
                i + 1 < runs.count, runs[i + 1].kind == .addition
            {
                deletionRuns.append(run.indices)
                additionRuns.append(runs[i + 1].indices)
                i += 2
            } else if run.kind == .addition,
                i + 1 < runs.count, runs[i + 1].kind == .deletion
            {
                // Unusual order; still pair positionally.
                additionRuns.append(run.indices)
                deletionRuns.append(runs[i + 1].indices)
                i += 2
            } else {
                // Unpaired run — leave flat (no entry in result).
                i += 1
            }
        }

        var result: [Int: [IntralineSpan]] = [:]
        let pairCount = min(deletionRuns.count, additionRuns.count)
        for pairIndex in 0..<pairCount {
            let dels = deletionRuns[pairIndex]
            let adds = additionRuns[pairIndex]
            let n = max(dels.count, adds.count)
            for j in 0..<n {
                let delLine = j < dels.count ? lines[dels[j]].text : ""
                let addLine = j < adds.count ? lines[adds[j]].text : ""
                let pair = diffTokens(old: delLine, new: addLine)
                if j < dels.count {
                    result[dels[j]] = pair.deletion
                }
                if j < adds.count {
                    result[adds[j]] = pair.addition
                }
            }
        }
        return result
    }

    // MARK: - LCS

    private static func longestCommonSubsequence(_ a: [String], _ b: [String]) -> [String] {
        let m = a.count
        let n = b.count
        if m == 0 || n == 0 { return [] }

        // Space-optimized path for short lines; full table is fine for code lines.
        var table = Array(repeating: Array(repeating: 0, count: n + 1), count: m + 1)
        for i in 1...m {
            for j in 1...n {
                if a[i - 1] == b[j - 1] {
                    table[i][j] = table[i - 1][j - 1] + 1
                } else {
                    table[i][j] = max(table[i - 1][j], table[i][j - 1])
                }
            }
        }

        var lcs: [String] = []
        var i = m
        var j = n
        while i > 0 && j > 0 {
            if a[i - 1] == b[j - 1] {
                lcs.append(a[i - 1])
                i -= 1
                j -= 1
            } else if table[i - 1][j] >= table[i][j - 1] {
                i -= 1
            } else {
                j -= 1
            }
        }
        return lcs.reversed()
    }

    private static func mark(tokens: [String], lcs: [String]) -> [IntralineSpan] {
        var spans: [IntralineSpan] = []
        var lcsIndex = 0
        for token in tokens {
            if lcsIndex < lcs.count && token == lcs[lcsIndex] {
                spans.append(IntralineSpan(text: token, isChanged: false))
                lcsIndex += 1
            } else {
                spans.append(IntralineSpan(text: token, isChanged: true))
            }
        }
        return spans
    }
}
