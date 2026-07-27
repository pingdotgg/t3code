import Foundation

// Small string reductions that run inside view bodies. SwiftUI rebuilds every
// visible row's view value on each timeline mutation, so a tool row's one-line
// preview and a user bubble's emptiness check are evaluated for the whole
// realized viewport on every streaming delta. The obvious spellings —
// `split(separator:).first`, `trimmingCharacters(in:).isEmpty`, `text.count` —
// each walk or copy the entire payload, which for a multi-kilobyte command or
// a pasted file is exactly the work a body evaluation cannot afford.

extension StringProtocol {
    /// The first line that has non-whitespace content, whitespace-trimmed, or
    /// nil when there is none.
    ///
    /// Equivalent to `split(separator: "\n", omittingEmptySubsequences: true)
    /// .first.map { $0.trimmingCharacters(in: .whitespaces) }` filtered for
    /// emptiness, but it stops at the first line it can return instead of
    /// materializing an array of every line in the payload.
    var firstNonBlankLine: String? {
        var lineStart = startIndex
        while lineStart < endIndex {
            let lineEnd = self[lineStart...].firstIndex(of: "\n") ?? endIndex
            let line = self[lineStart..<lineEnd]
            if let trimmed = line.trimmedIfNotBlank { return trimmed }
            guard lineEnd < endIndex else { break }
            lineStart = index(after: lineEnd)
        }
        return nil
    }

    /// True when there is at least one non-whitespace character. Unlike
    /// `!trimmingCharacters(in: .whitespacesAndNewlines).isEmpty` this
    /// allocates nothing and returns at the first such character.
    var hasVisibleContent: Bool {
        contains { !$0.isWhitespace }
    }

    /// This string trimmed of leading and trailing whitespace, or nil when
    /// that leaves nothing. Allocates only for a string it will return.
    var trimmedIfNotBlank: String? {
        guard var start = firstIndex(where: { !$0.isWhitespace }) else { return nil }
        var end = endIndex
        while end > start, self[index(before: end)].isWhitespace {
            end = index(before: end)
        }
        // `start` is already the first non-whitespace character; the walk
        // above cannot have crossed it.
        if start > end { start = end }
        return String(self[start..<end])
    }
}
