import Foundation

/// Finds Markdown block boundaries that are safe to parse independently while
/// an assistant message is still growing.
///
/// A candidate is the byte offset immediately after a whitespace-only line,
/// provided that line was outside a fenced code block. It is promoted to a
/// safe boundary only after the next non-blank line is known not to continue a
/// list or an indented code block. Keeping the candidate pending matters for
/// loose lists: parsing the second half as a fresh document would restart an
/// ordered list at one, while the renderer numbers items from the parsed
/// list's start index.
struct MarkdownSafeSplitScanner {
    private(set) var lastSafeBoundary = 0

    private var scannedOffset = 0
    private var currentLineStartOffset = 0
    private var currentLine: [UInt8] = []
    private var pendingCandidate: Int?

    private var inFence = false
    private var fenceChar: UInt8 = 0
    private var fenceRunLength = 0
    private var fenceIndent = 0

    /// Consumes only bytes that have not already been passed to this scanner.
    /// The state is deliberately byte-based so offsets remain valid for UTF-8
    /// source slices and no partial scalar can be decoded while streaming.
    mutating func consume(_ bytes: some Collection<UInt8>) {
        for byte in bytes {
            currentLine.append(byte)
            scannedOffset += 1

            guard byte == 0x0A else { continue }
            finishLine(at: scannedOffset)
        }
    }

    private mutating func finishLine(at lineEnd: Int) {
        let line = lineContent
        currentLine.removeAll(keepingCapacity: true)
        currentLineStartOffset = lineEnd

        if inFence {
            // Blank lines inside a fence are never candidates. A closing
            // fence itself is also part of the fenced block; candidates can
            // resume only on a later blank line.
            if !isBlank(line), let close = closingFence(in: line) {
                inFence = false
                fenceChar = 0
                fenceRunLength = 0
                fenceIndent = 0
                _ = close
            }
            return
        }

        if isBlank(line) {
            pendingCandidate = lineEnd
            return
        }

        if let candidate = pendingCandidate {
            if canStartIndependentBlock(line) {
                lastSafeBoundary = candidate
            }
            pendingCandidate = nil
        }

        if let opening = openingFence(in: line) {
            inFence = true
            fenceChar = opening.char
            fenceRunLength = opening.runLength
            fenceIndent = opening.indent
        }
    }

    private var lineContent: ArraySlice<UInt8> {
        var end = currentLine.endIndex
        if end > currentLine.startIndex, currentLine[end - 1] == 0x0A {
            end -= 1
        }
        if end > currentLine.startIndex, currentLine[end - 1] == 0x0D {
            end -= 1
        }
        return currentLine[currentLine.startIndex..<end]
    }

    private func isBlank(_ line: ArraySlice<UInt8>) -> Bool {
        line.allSatisfy { $0 == 0x20 || $0 == 0x09 }
    }

    /// A split is unsafe before a following list marker or an indented
    /// continuation. Other block starts, including headings, paragraphs, and
    /// quotes, can begin the independently parsed tail.
    private func canStartIndependentBlock(_ line: ArraySlice<UInt8>) -> Bool {
        var index = line.startIndex
        var spaces = 0
        while index < line.endIndex, line[index] == 0x20, spaces < 4 {
            spaces += 1
            index += 1
        }

        if spaces >= 4 || (index < line.endIndex && line[index] == 0x09) {
            return false
        }

        guard index < line.endIndex else { return false }
        let marker = line[index]
        if marker == 0x2D || marker == 0x2A || marker == 0x2B {
            let afterMarker = line.index(after: index)
            guard afterMarker < line.endIndex else { return true }
            return line[afterMarker] != 0x20 && line[afterMarker] != 0x09
        }

        guard marker >= 0x30, marker <= 0x39 else { return true }
        var digitCount = 0
        var cursor = index
        while cursor < line.endIndex, line[cursor] >= 0x30, line[cursor] <= 0x39 {
            digitCount += 1
            cursor = line.index(after: cursor)
            if digitCount > 9 { return true }
        }
        guard digitCount > 0 else { return true }
        guard cursor < line.endIndex else { return true }
        guard line[cursor] == 0x2E || line[cursor] == 0x29 else { return true }
        let afterMarker = line.index(after: cursor)
        guard afterMarker < line.endIndex else { return true }
        return line[afterMarker] != 0x20 && line[afterMarker] != 0x09
    }

    private struct Fence {
        let char: UInt8
        let runLength: Int
        let indent: Int
    }

    private func openingFence(in line: ArraySlice<UInt8>) -> Fence? {
        var index = line.startIndex
        var indent = 0
        while index < line.endIndex, line[index] == 0x20 {
            indent += 1
            index += 1
            if indent > 3 { return nil }
        }
        guard index < line.endIndex else { return nil }
        let char = line[index]
        guard char == 0x60 || char == 0x7E else { return nil }

        var runLength = 0
        var cursor = index
        while cursor < line.endIndex, line[cursor] == char {
            runLength += 1
            cursor = line.index(after: cursor)
        }
        guard runLength >= 3 else { return nil }

        // CommonMark disallows a backtick in a backtick fence's info string.
        // Tilde fences have no corresponding restriction.
        if char == 0x60, line[cursor..<line.endIndex].contains(char) {
            return nil
        }
        return Fence(char: char, runLength: runLength, indent: indent)
    }

    private func closingFence(in line: ArraySlice<UInt8>) -> Fence? {
        var index = line.startIndex
        var indent = 0
        while index < line.endIndex, line[index] == 0x20 {
            indent += 1
            index += 1
            if indent > 3 { return nil }
        }
        guard index < line.endIndex, line[index] == fenceChar else { return nil }

        var runLength = 0
        var cursor = index
        while cursor < line.endIndex, line[cursor] == fenceChar {
            runLength += 1
            cursor = line.index(after: cursor)
        }
        guard runLength >= fenceRunLength else { return nil }
        guard line[cursor..<line.endIndex].allSatisfy({ $0 == 0x20 || $0 == 0x09 }) else {
            return nil
        }
        return Fence(char: fenceChar, runLength: runLength, indent: indent)
    }
}

/// Incremental cache for assistant messages that are still streaming.
///
/// The cache intentionally accepts a small transient correctness gap: an HTML
/// block (`<pre>`, `<script>`, `<style>`, or `<textarea>`) or a link-reference
/// definition can span a split. Such artifacts are short-lived because the
/// completed message calls the normal full-document parser below.
@MainActor
enum StreamingMarkdownCache {
    private struct SessionKey: Equatable {
        let threadID: String
        let messageID: String
    }

    private static var sessions: [String: [String: StreamingMarkdownSession]] = [:]
    private static var insertionOrder: [SessionKey] = []
    private static let maxSessionCount = 8

    private(set) static var segmentParseCount = 0
    private(set) static var tailBytesParsedTotal = 0
    private(set) static var resetCount = 0

    static func document(
        threadID: String, messageID: String, markdown: String
    ) -> ParsedMarkdownDocument {
        let session = session(threadID: threadID, messageID: messageID)
        let byteCount = markdown.utf8.count

        // SwiftUI can reevaluate a view many times between two stream flushes.
        // The count is the cheap identity key for that unchanged body value.
        if byteCount == session.lastCount {
            return session.lastDocument
        }

        withContiguousUTF8(markdown) { input in
            let previousCount = session.bytes.count
            var appendOnly = input.count >= previousCount
            if appendOnly, previousCount > 0 {
                let comparisonCount = min(64, previousCount)
                let start = previousCount - comparisonCount
                appendOnly = input[start..<previousCount].elementsEqual(
                    session.bytes[start..<previousCount])
            }

            if !appendOnly {
                reset(session)
            }

            let oldCount = session.bytes.count
            guard input.count > oldCount else { return }
            let suffix = input[oldCount..<input.count]
            session.bytes.append(contentsOf: suffix)
            session.scanner.consume(suffix)
        }

        if session.scanner.lastSafeBoundary > session.settledUpTo {
            let boundary = session.scanner.lastSafeBoundary
            let segment = String(
                decoding: session.bytes[session.settledUpTo..<boundary], as: UTF8.self)
            let parsed = MarkdownBlockCache.document(for: segment)
            session.settledBlocks.append(contentsOf: parsed.blocks)
            session.settledKeys.append(contentsOf: parsed.blockKeys)
            session.settledUpTo = boundary
            segmentParseCount += 1
        }

        let tailByteCount = session.bytes.count - session.settledUpTo
        let tail = String(decoding: session.bytes[session.settledUpTo...], as: UTF8.self)
        let tailDocument = MarkdownBlockCache.document(for: tail)
        tailBytesParsedTotal += tailByteCount

        // Segment-relative source keys can repeat across segments; the
        // renderer disambiguates identical keys by occurrence, so the
        // concatenation stays render-stable.
        session.lastDocument = ParsedMarkdownDocument(
            blocks: session.settledBlocks + tailDocument.blocks,
            blockKeys: session.settledKeys + tailDocument.blockKeys)
        session.lastCount = byteCount
        return session.lastDocument
    }

    static func finish(threadID: String, messageID: String) {
        guard var threadSessions = sessions[threadID], threadSessions[messageID] != nil else {
            return
        }
        threadSessions[messageID] = nil
        if threadSessions.isEmpty {
            sessions[threadID] = nil
        } else {
            sessions[threadID] = threadSessions
        }
        insertionOrder.removeAll { $0.threadID == threadID && $0.messageID == messageID }
    }

    static func evict(threadID: String) {
        sessions[threadID] = nil
        insertionOrder.removeAll { $0.threadID == threadID }
    }

    static func resetForTesting() {
        sessions.removeAll(keepingCapacity: true)
        insertionOrder.removeAll(keepingCapacity: true)
        segmentParseCount = 0
        tailBytesParsedTotal = 0
        resetCount = 0
    }

    private static func session(threadID: String, messageID: String) -> StreamingMarkdownSession {
        if let existing = sessions[threadID]?[messageID] {
            return existing
        }

        if insertionOrder.count >= maxSessionCount, let oldest = insertionOrder.first {
            insertionOrder.removeFirst()
            sessions[oldest.threadID]?[oldest.messageID] = nil
            if sessions[oldest.threadID]?.isEmpty == true {
                sessions[oldest.threadID] = nil
            }
        }

        let created = StreamingMarkdownSession()
        sessions[threadID, default: [:]][messageID] = created
        insertionOrder.append(SessionKey(threadID: threadID, messageID: messageID))
        return created
    }

    private static func reset(_ session: StreamingMarkdownSession) {
        session.bytes = []
        session.scanner = MarkdownSafeSplitScanner()
        session.settledBlocks = []
        session.settledKeys = []
        session.settledUpTo = 0
        session.lastCount = -1
        session.lastDocument = ParsedMarkdownDocument(blocks: [], blockKeys: [])
        resetCount += 1
    }

    private static func withContiguousUTF8<Result>(
        _ markdown: String,
        _ body: (UnsafeBufferPointer<UInt8>) -> Result
    ) -> Result {
        if let result = markdown.utf8.withContiguousStorageIfAvailable(body) {
            return result
        }

        var contiguous = markdown
        contiguous.makeContiguousUTF8()
        if let result = contiguous.utf8.withContiguousStorageIfAvailable(body) {
            return result
        }

        // The retry above is the normal fallback. Keep this last branch only
        // as a defensive correctness path for an unexpected String storage
        // implementation; it is outside the streaming hot path.
        return Array(contiguous.utf8).withUnsafeBufferPointer(body)
    }
}

@MainActor
private final class StreamingMarkdownSession {
    var bytes: [UInt8] = []
    var scanner = MarkdownSafeSplitScanner()
    var settledBlocks: [MarkdownBlock] = []
    var settledKeys: [String] = []
    var settledUpTo = 0
    var lastCount = -1
    var lastDocument = ParsedMarkdownDocument(blocks: [], blockKeys: [])
}
