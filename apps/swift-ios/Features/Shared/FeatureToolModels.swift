import Foundation

public struct FeatureCapabilityUnavailable: LocalizedError, Sendable, Equatable {
    public let capability: String

    public init(_ capability: String) {
        self.capability = capability
    }

    public var errorDescription: String? {
        "\(capability) is not supported by this environment."
    }
}

/// Optional rich-file capability. The base file contract is deliberately text-only,
/// while native clients can resolve the existing signed workspace asset route for images.
@MainActor
public protocol FeatureWorkspaceAssetResolving: AnyObject {
    func workspaceAssetURL(threadID: String, path: String) async throws -> URL
}

public enum FeatureFileKind: String, Sendable, Codable {
    case file
    case directory
    case symbolicLink
}

public struct FeatureFileEntry: Identifiable, Sendable, Equatable, Hashable, Codable {
    public var id: String { path }
    public let path: String
    public var name: String
    public var kind: FeatureFileKind
    public var sizeBytes: Int?
    public var isHidden: Bool

    public init(
        path: String,
        name: String,
        kind: FeatureFileKind,
        sizeBytes: Int? = nil,
        isHidden: Bool = false
    ) {
        self.path = path
        self.name = name
        self.kind = kind
        self.sizeBytes = sizeBytes
        self.isHidden = isHidden
    }
}

public extension Array where Element == FeatureFileEntry {
    func featureFiltered(by query: String, includesHidden: Bool) -> [FeatureFileEntry] {
        let visible = includesHidden ? self : filter { !$0.isHidden }
        let filtered: [FeatureFileEntry]
        if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            filtered = visible
        } else {
            filtered = visible.filter { $0.name.localizedCaseInsensitiveContains(query) }
        }
        return filtered.sorted {
            if $0.kind == .directory, $1.kind != .directory { return true }
            if $0.kind != .directory, $1.kind == .directory { return false }
            return $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
    }
}

public struct FeatureFileContent: Sendable, Equatable, Codable {
    public var path: String
    public var text: String
    public var language: String?
    public var isTruncated: Bool
    public var totalBytes: Int?

    public init(
        path: String,
        text: String,
        language: String? = nil,
        isTruncated: Bool = false,
        totalBytes: Int? = nil
    ) {
        self.path = path
        self.text = text
        self.language = language
        self.isTruncated = isTruncated
        self.totalBytes = totalBytes
    }
}

public enum FeatureFilePreviewKind: Sendable, Equatable {
    case image
    case markdown
    case source
    case plainText

    public static func infer(path: String, language: String? = nil) -> Self {
        let fileExtension = URL(fileURLWithPath: path).pathExtension.lowercased()
        if imageExtensions.contains(fileExtension) { return .image }
        if language?.lowercased() == "markdown" || ["md", "mdx"].contains(fileExtension) {
            return .markdown
        }
        if language != nil || sourceExtensions.contains(fileExtension) { return .source }
        return .plainText
    }

    private static let imageExtensions: Set<String> = [
        "avif", "gif", "ico", "jpeg", "jpg", "png", "webp",
    ]

    private static let sourceExtensions: Set<String> = [
        "c", "cc", "cpp", "cs", "css", "go", "h", "hpp", "html", "java", "js", "jsx",
        "json", "kt", "kts", "m", "mm", "php", "py", "rb", "rs", "scss", "sh", "sql",
        "swift", "toml", "ts", "tsx", "vue", "xml", "yaml", "yml", "zsh",
    ]
}

public enum FeatureSourceTokenKind: String, Sendable, Equatable, Hashable, Codable {
    case plain
    case comment
    case keyword
    case literal
    case number
    case property
}

public struct FeatureSourceSpan: Sendable, Equatable, Hashable, Codable {
    public var text: String
    public var kind: FeatureSourceTokenKind

    public init(text: String, kind: FeatureSourceTokenKind) {
        self.text = text
        self.kind = kind
    }
}

public struct FeatureSourceLine: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: Int
    public var spans: [FeatureSourceSpan]

    public init(id: Int, spans: [FeatureSourceSpan]) {
        self.id = id
        self.spans = spans
    }

    public var number: Int { id + 1 }
    public var text: String { spans.map(\.text).joined() }
}

/// A bounded, language-aware lexer for file previews. It runs once when a file loads;
/// SwiftUI receives immutable line plans and performs no regex or token work while scrolling.
public enum FeatureSourceHighlighter {
    public static func lines(text: String, language: String?) -> [FeatureSourceLine] {
        let sourceLines = text.split(separator: "\n", omittingEmptySubsequences: false)
        let highlightsContent = text.utf8.count <= 512 * 1_024
        var isInsideBlockComment = false
        return sourceLines.enumerated().map { index, line in
            guard highlightsContent, line.utf8.count <= 32 * 1_024 else {
                return FeatureSourceLine(
                    id: index,
                    spans: line.isEmpty
                        ? []
                        : [FeatureSourceSpan(text: String(line), kind: .plain)]
                )
            }
            return FeatureSourceLine(
                id: index,
                spans: spans(
                    in: String(line),
                    language: language?.lowercased(),
                    isInsideBlockComment: &isInsideBlockComment
                )
            )
        }
    }

    private static func spans(
        in line: String,
        language: String?,
        isInsideBlockComment: inout Bool
    ) -> [FeatureSourceSpan] {
        let characters = Array(line)
        var output: [FeatureSourceSpan] = []
        var index = 0
        let lineComment = lineCommentMarker(for: language)
        let supportsBlockComments = blockCommentLanguages.contains(language ?? "")
        let keywords = keywords(for: language)

        func hasPrefix(_ prefix: [Character], at offset: Int) -> Bool {
            guard offset + prefix.count <= characters.count else { return false }
            return characters[offset ..< offset + prefix.count].elementsEqual(prefix)
        }

        func append(_ range: Range<Int>, kind: FeatureSourceTokenKind) {
            guard !range.isEmpty else { return }
            let text = String(characters[range])
            if output.last?.kind == kind {
                output[output.count - 1].text += text
            } else {
                output.append(FeatureSourceSpan(text: text, kind: kind))
            }
        }

        while index < characters.count {
            if isInsideBlockComment {
                let start = index
                while index < characters.count, !hasPrefix(["*", "/"], at: index) {
                    index += 1
                }
                if index < characters.count {
                    index += 2
                    isInsideBlockComment = false
                }
                append(start ..< index, kind: .comment)
                continue
            }

            if let lineComment, hasPrefix(Array(lineComment), at: index) {
                append(index ..< characters.count, kind: .comment)
                break
            }

            if supportsBlockComments, hasPrefix(["/", "*"], at: index) {
                let start = index
                index += 2
                while index < characters.count, !hasPrefix(["*", "/"], at: index) {
                    index += 1
                }
                if index < characters.count {
                    index += 2
                } else {
                    isInsideBlockComment = true
                }
                append(start ..< index, kind: .comment)
                continue
            }

            if ["\"", "'", "`"].contains(characters[index]) {
                let start = index
                let delimiter = characters[index]
                index += 1
                var isEscaped = false
                while index < characters.count {
                    let character = characters[index]
                    index += 1
                    if character == delimiter, !isEscaped { break }
                    isEscaped = character == "\\" && !isEscaped
                    if character != "\\" { isEscaped = false }
                }
                var next = index
                while next < characters.count, characters[next].isWhitespace { next += 1 }
                let kind: FeatureSourceTokenKind = next < characters.count
                    && characters[next] == ":"
                    && propertyLanguages.contains(language ?? "")
                    ? .property
                    : .literal
                append(start ..< index, kind: kind)
                continue
            }

            if characters[index].isNumber {
                let start = index
                index += 1
                while index < characters.count,
                      characters[index].isNumber
                        || [".", "_", "x", "X", "a", "b", "c", "d", "e", "f", "A", "B", "C", "D", "E", "F"].contains(characters[index]) {
                    index += 1
                }
                append(start ..< index, kind: .number)
                continue
            }

            if isIdentifierStart(characters[index]) {
                let start = index
                index += 1
                while index < characters.count, isIdentifierBody(characters[index]) {
                    index += 1
                }
                let token = String(characters[start ..< index])
                var next = index
                while next < characters.count, characters[next].isWhitespace { next += 1 }
                let kind: FeatureSourceTokenKind
                if ["true", "false", "null", "nil", "undefined"].contains(token) {
                    kind = .literal
                } else if keywords.contains(token) {
                    kind = .keyword
                } else if next < characters.count,
                          characters[next] == ":",
                          propertyLanguages.contains(language ?? "") {
                    kind = .property
                } else {
                    kind = .plain
                }
                append(start ..< index, kind: kind)
                continue
            }

            append(index ..< index + 1, kind: .plain)
            index += 1
        }
        return output
    }

    private static func lineCommentMarker(for language: String?) -> String? {
        switch language {
        case "plain": nil
        case "python", "shell", "ruby", "yaml", "toml": "#"
        case "sql": "--"
        case "html", "xml", "css", "scss": nil
        default: "//"
        }
    }

    private static func keywords(for language: String?) -> Set<String> {
        switch language {
        case "plain": []
        case "swift": swiftKeywords
        case "typescript", "javascript": javascriptKeywords
        case "python": pythonKeywords
        case "rust": rustKeywords
        case "go": goKeywords
        case "shell": shellKeywords
        default: commonKeywords
        }
    }

    private static func isIdentifierStart(_ character: Character) -> Bool {
        character == "_" || character == "$" || character.isLetter
    }

    private static func isIdentifierBody(_ character: Character) -> Bool {
        isIdentifierStart(character) || character.isNumber || character == "-"
    }

    private static let propertyLanguages: Set<String> = ["json", "typescript", "javascript", "yaml"]
    private static let blockCommentLanguages: Set<String> = [
        "css", "go", "java", "javascript", "rust", "scss", "swift", "typescript",
    ]
    private static let commonKeywords: Set<String> = [
        "class", "const", "else", "enum", "false", "for", "func", "function", "if", "import",
        "let", "nil", "null", "private", "public", "return", "struct", "true", "var", "while",
    ]
    private static let swiftKeywords = commonKeywords.union([
        "actor", "any", "associatedtype", "async", "await", "case", "defer", "extension", "guard",
        "in", "init", "internal", "nonisolated", "opaque", "protocol", "self", "some", "switch",
        "throws", "try", "typealias", "where",
    ])
    private static let javascriptKeywords = commonKeywords.union([
        "as", "break", "case", "catch", "continue", "default", "export", "extends", "from", "interface",
        "new", "of", "static", "throw", "type", "typeof", "undefined",
    ])
    private static let pythonKeywords = commonKeywords.union([
        "and", "as", "assert", "async", "await", "def", "elif", "except", "finally", "from", "in",
        "is", "lambda", "not", "or", "pass", "raise", "with", "yield",
    ])
    private static let rustKeywords = commonKeywords.union([
        "as", "async", "await", "crate", "dyn", "impl", "in", "loop", "match", "mod", "move", "mut",
        "ref", "self", "trait", "type", "unsafe", "use", "where",
    ])
    private static let goKeywords = commonKeywords.union([
        "break", "case", "chan", "continue", "defer", "fallthrough", "go", "goto", "interface", "map",
        "package", "range", "select", "type",
    ])
    private static let shellKeywords = commonKeywords.union([
        "case", "do", "done", "elif", "esac", "export", "fi", "in", "then",
    ])
}

public enum FeatureDiffLineKind: String, Sendable, Codable {
    case context
    case addition
    case deletion
    case hunk
}

public struct FeatureDiffLine: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    public var kind: FeatureDiffLineKind
    public var oldLine: Int?
    public var newLine: Int?
    public var text: String
    public var spans: [FeatureDiffTextSpan]?

    public init(
        id: String,
        kind: FeatureDiffLineKind,
        oldLine: Int? = nil,
        newLine: Int? = nil,
        text: String,
        spans: [FeatureDiffTextSpan]? = nil
    ) {
        self.id = id
        self.kind = kind
        self.oldLine = oldLine
        self.newLine = newLine
        self.text = text
        self.spans = spans
    }
}

public enum FeatureDiffTextSpanKind: String, Sendable, Equatable, Hashable, Codable {
    case unchanged
    case changed
}

public struct FeatureDiffTextSpan: Sendable, Equatable, Hashable, Codable {
    public var text: String
    public var kind: FeatureDiffTextSpanKind

    public init(text: String, kind: FeatureDiffTextSpanKind) {
        self.text = text
        self.kind = kind
    }
}

public enum FeatureDiffWordHighlighter {
    public static func spans(
        old: String,
        new: String
    ) -> (old: [FeatureDiffTextSpan], new: [FeatureDiffTextSpan]) {
        guard old != new else {
            let unchanged = [FeatureDiffTextSpan(text: old, kind: .unchanged)]
            return (unchanged, unchanged)
        }
        let oldTokens = tokens(in: old)
        let newTokens = tokens(in: new)
        guard !oldTokens.isEmpty, !newTokens.isEmpty,
              oldTokens.count * newTokens.count <= 20_000 else {
            return (changed(old), changed(new))
        }

        var lengths = Array(
            repeating: Array(repeating: 0, count: newTokens.count + 1),
            count: oldTokens.count + 1
        )
        for oldIndex in oldTokens.indices.reversed() {
            for newIndex in newTokens.indices.reversed() {
                lengths[oldIndex][newIndex] = oldTokens[oldIndex] == newTokens[newIndex]
                    ? lengths[oldIndex + 1][newIndex + 1] + 1
                    : max(lengths[oldIndex + 1][newIndex], lengths[oldIndex][newIndex + 1])
            }
        }

        var oldMatches = Array(repeating: false, count: oldTokens.count)
        var newMatches = Array(repeating: false, count: newTokens.count)
        var oldIndex = 0
        var newIndex = 0
        while oldIndex < oldTokens.count, newIndex < newTokens.count {
            if oldTokens[oldIndex] == newTokens[newIndex] {
                oldMatches[oldIndex] = true
                newMatches[newIndex] = true
                oldIndex += 1
                newIndex += 1
            } else if lengths[oldIndex + 1][newIndex] >= lengths[oldIndex][newIndex + 1] {
                oldIndex += 1
            } else {
                newIndex += 1
            }
        }

        return (
            makeSpans(tokens: oldTokens, matches: oldMatches),
            makeSpans(tokens: newTokens, matches: newMatches)
        )
    }

    private static func tokens(in text: String) -> [String] {
        var output: [String] = []
        var current = ""
        var currentClass: TokenClass?
        for character in text {
            let tokenClass: TokenClass = if character.isWhitespace {
                .whitespace
            } else if character.isLetter || character.isNumber || character == "_" || character == "$" {
                .word
            } else {
                .punctuation
            }
            if tokenClass == .punctuation {
                if !current.isEmpty { output.append(current) }
                output.append(String(character))
                current = ""
                currentClass = nil
            } else if currentClass == tokenClass {
                current.append(character)
            } else {
                if !current.isEmpty { output.append(current) }
                current = String(character)
                currentClass = tokenClass
            }
        }
        if !current.isEmpty { output.append(current) }
        return output
    }

    private static func makeSpans(
        tokens: [String],
        matches: [Bool]
    ) -> [FeatureDiffTextSpan] {
        var output: [FeatureDiffTextSpan] = []
        for (index, token) in tokens.enumerated() {
            let isWhitespace = token.allSatisfy(\.isWhitespace)
            let kind: FeatureDiffTextSpanKind = matches[index] || isWhitespace
                ? .unchanged
                : .changed
            if output.last?.kind == kind {
                output[output.count - 1].text += token
            } else {
                output.append(FeatureDiffTextSpan(text: token, kind: kind))
            }
        }
        return output
    }

    private static func changed(_ text: String) -> [FeatureDiffTextSpan] {
        [FeatureDiffTextSpan(text: text, kind: .changed)]
    }

    private enum TokenClass {
        case whitespace
        case word
        case punctuation
    }
}

public enum FeatureReviewLineSide: String, Sendable, Equatable, Hashable, Codable {
    case old
    case new
}

public struct FeatureReviewLineSelection: Sendable, Equatable, Hashable, Codable {
    public var side: FeatureReviewLineSide
    public var line: Int

    public init(side: FeatureReviewLineSide, line: Int) {
        self.side = side
        self.line = line
    }
}

public struct FeatureReviewCommentDraft: Sendable, Equatable, Hashable {
    public var filePath: String
    public var line: FeatureReviewLineSelection?
    public var body: String

    public init(filePath: String, line: FeatureReviewLineSelection? = nil, body: String) {
        self.filePath = filePath
        self.line = line
        self.body = body
    }

    public var prompt: String {
        let location = line.map { " at \($0.side.rawValue) line \($0.line)" } ?? ""
        return """
        Address this review comment in `\(filePath)`\(location):

        \(body.trimmingCharacters(in: .whitespacesAndNewlines))

        Inspect the surrounding code, make the smallest correct change, and report what changed.
        """
    }
}

public enum FeatureReviewChangeKind: String, Sendable, Codable {
    case added
    case modified
    case deleted
    case renamed
    case binary
}

public struct FeatureReviewFile: Identifiable, Sendable, Equatable, Hashable, Codable {
    public var id: String { path }
    public var path: String
    public var previousPath: String?
    public var change: FeatureReviewChangeKind
    public var additions: Int
    public var deletions: Int
    public var lines: [FeatureDiffLine]
    public var sourceKind: String?
    public var sourceBaseReference: String?
    public var sourceHeadReference: String?

    public init(
        path: String,
        previousPath: String? = nil,
        change: FeatureReviewChangeKind,
        additions: Int,
        deletions: Int,
        lines: [FeatureDiffLine] = [],
        sourceKind: String? = nil,
        sourceBaseReference: String? = nil,
        sourceHeadReference: String? = nil
    ) {
        self.path = path
        self.previousPath = previousPath
        self.change = change
        self.additions = additions
        self.deletions = deletions
        self.lines = lines
        self.sourceKind = sourceKind
        self.sourceBaseReference = sourceBaseReference
        self.sourceHeadReference = sourceHeadReference
    }
}

public struct FeatureReviewFileContents: Sendable, Equatable {
    public var oldContents: String
    public var newContents: String

    public init(oldContents: String, newContents: String) {
        self.oldContents = oldContents
        self.newContents = newContents
    }
}

enum FeatureFullDiffHydrator {
    static func lines(
        for file: FeatureReviewFile,
        contents: FeatureReviewFileContents
    ) -> [FeatureDiffLine] {
        let oldLines = contentLines(contents.oldContents)
        let newLines = contentLines(contents.newContents)

        switch file.change {
        case .added:
            return wholeFileLines(newLines, kind: .addition, side: .new, path: file.path)
        case .deleted:
            return wholeFileLines(oldLines, kind: .deletion, side: .old, path: file.path)
        case .renamed where file.additions == 0 && file.deletions == 0:
            return newLines.enumerated().map { index, text in
                FeatureDiffLine(
                    id: "full-\(file.path)-\(index + 1)",
                    kind: .context,
                    oldLine: index + 1,
                    newLine: index + 1,
                    text: text
                )
            }
        case .modified, .renamed, .binary:
            break
        }

        let patchLines = file.lines.filter { $0.kind != .hunk }
        guard !newLines.isEmpty else { return file.lines }
        guard !patchLines.isEmpty else {
            return newLines.enumerated().map { index, text in
                FeatureDiffLine(
                    id: "full-\(file.path)-\(index + 1)",
                    kind: .context,
                    oldLine: oldLines.indices.contains(index) ? index + 1 : nil,
                    newLine: index + 1,
                    text: text
                )
            }
        }

        let anchors = patchLines.compactMap { line -> (new: Int, offset: Int)? in
            guard let oldLine = line.oldLine, let newLine = line.newLine else { return nil }
            return (newLine, oldLine - newLine)
        }
        // Anchors ascend by new-line number; binary search keeps hydration
        // linear instead of scanning every anchor per emitted context line.
        func oldLine(for newLine: Int) -> Int? {
            guard !anchors.isEmpty else { return nil }
            var low = 0
            var high = anchors.count
            while low < high {
                let mid = (low + high) / 2
                if anchors[mid].new <= newLine {
                    low = mid + 1
                } else {
                    high = mid
                }
            }
            let anchor = low > 0 ? anchors[low - 1] : anchors[0]
            return newLine + anchor.offset
        }

        var output: [FeatureDiffLine] = []
        var nextNewLine = 1
        var precedingAnchorOffset: Int?
        for (index, line) in patchLines.enumerated() {
            if let newLine = line.newLine {
                if nextNewLine < newLine {
                    for number in nextNewLine ..< newLine where newLines.indices.contains(number - 1) {
                        output.append(
                            FeatureDiffLine(
                                id: "full-\(file.path)-\(number)",
                                kind: .context,
                                oldLine: oldLine(for: number),
                                newLine: number,
                                text: newLines[number - 1]
                            )
                        )
                    }
                }
                output.append(line)
                nextNewLine = max(nextNewLine, newLine + 1)
                if let oldLine = line.oldLine {
                    precedingAnchorOffset = oldLine - newLine
                }
            } else {
                let insertionLine: Int
                if let oldLine = line.oldLine, let precedingAnchorOffset {
                    insertionLine = oldLine - precedingAnchorOffset
                } else {
                    insertionLine = patchLines.dropFirst(index + 1).compactMap(\.newLine).first
                        ?? (newLines.count + 1)
                }
                if nextNewLine < insertionLine {
                    for number in nextNewLine ..< insertionLine
                    where newLines.indices.contains(number - 1) {
                        output.append(
                            FeatureDiffLine(
                                id: "full-\(file.path)-\(number)",
                                kind: .context,
                                oldLine: oldLine(for: number),
                                newLine: number,
                                text: newLines[number - 1]
                            )
                        )
                    }
                    nextNewLine = insertionLine
                }
                output.append(line)
            }
        }
        if nextNewLine <= newLines.count {
            for number in nextNewLine ... newLines.count {
                output.append(
                    FeatureDiffLine(
                        id: "full-\(file.path)-\(number)",
                        kind: .context,
                        oldLine: oldLine(for: number),
                        newLine: number,
                        text: newLines[number - 1]
                    )
                )
            }
        }
        return output
    }

    private enum Side: Equatable { case old, new }

    private static func wholeFileLines(
        _ lines: [String],
        kind: FeatureDiffLineKind,
        side: Side,
        path: String
    ) -> [FeatureDiffLine] {
        lines.enumerated().map { index, text in
            let number = index + 1
            return FeatureDiffLine(
                id: "full-\(path)-\(number)",
                kind: kind,
                oldLine: side == .old ? number : nil,
                newLine: side == .new ? number : nil,
                text: text
            )
        }
    }

    private static func contentLines(_ contents: String) -> [String] {
        guard !contents.isEmpty else { return [] }
        var lines = contents.components(separatedBy: "\n")
        if lines.last?.isEmpty == true { lines.removeLast() }
        return lines
    }
}

public struct FeatureReview: Sendable, Equatable, Codable {
    public var title: String
    public var baseReference: String?
    public var files: [FeatureReviewFile]
    public var isTruncated: Bool

    public init(
        title: String = "Working tree",
        baseReference: String? = nil,
        files: [FeatureReviewFile] = [],
        isTruncated: Bool = false
    ) {
        self.title = title
        self.baseReference = baseReference
        self.files = files
        self.isTruncated = isTruncated
    }

    public var additions: Int { files.reduce(0) { $0 + $1.additions } }
    public var deletions: Int { files.reduce(0) { $0 + $1.deletions } }
}

public enum FeatureSourceControlFileState: String, Sendable, Codable {
    case added
    case modified
    case deleted
    case renamed
    case untracked
    case conflicted
}

public struct FeatureSourceControlFile: Identifiable, Sendable, Equatable, Hashable, Codable {
    public var id: String { path }
    public var path: String
    public var state: FeatureSourceControlFileState
    public var isStaged: Bool

    public init(path: String, state: FeatureSourceControlFileState, isStaged: Bool) {
        self.path = path
        self.state = state
        self.isStaged = isStaged
    }
}

public struct FeaturePullRequest: Sendable, Equatable, Hashable, Codable {
    public var number: Int
    public var title: String
    public var state: String
    public var url: URL?

    public init(number: Int, title: String, state: String, url: URL? = nil) {
        self.number = number
        self.title = title
        self.state = state
        self.url = url
    }
}

public enum FeatureSourceControlAction: String, CaseIterable, Sendable, Codable {
    case commit
    case push
    case pull
    case createPullRequest
    case commitAndPush
    case commitPushAndCreatePullRequest
}

public struct FeatureSourceControlStatus: Sendable, Equatable, Codable {
    public var isRepository: Bool
    public var branch: String?
    public var upstream: String?
    public var aheadCount: Int
    public var behindCount: Int
    public var files: [FeatureSourceControlFile]
    public var pullRequest: FeaturePullRequest?
    public var isBusy: Bool

    public init(
        isRepository: Bool = true,
        branch: String? = nil,
        upstream: String? = nil,
        aheadCount: Int = 0,
        behindCount: Int = 0,
        files: [FeatureSourceControlFile] = [],
        pullRequest: FeaturePullRequest? = nil,
        isBusy: Bool = false
    ) {
        self.isRepository = isRepository
        self.branch = branch
        self.upstream = upstream
        self.aheadCount = aheadCount
        self.behindCount = behindCount
        self.files = files
        self.pullRequest = pullRequest
        self.isBusy = isBusy
    }

    public var availableActions: [FeatureSourceControlAction] {
        guard isRepository, !isBusy else { return [] }
        var actions: [FeatureSourceControlAction] = []
        if !files.isEmpty {
            actions.append(.commit)
            actions.append(.commitAndPush)
            if pullRequest == nil {
                actions.append(.commitPushAndCreatePullRequest)
            }
        }
        if aheadCount > 0 { actions.append(.push) }
        if behindCount > 0 { actions.append(.pull) }
        if pullRequest == nil { actions.append(.createPullRequest) }
        return actions
    }
}

public enum FeatureTerminalState: String, Sendable, Codable {
    case stopped
    case starting
    case running
    case exited
    case failed
}

public struct FeatureTerminalSnapshot: Sendable, Equatable, Codable {
    public var threadID: String
    public var terminalID: String
    public var state: FeatureTerminalState
    public var title: String
    public var workingDirectory: String?
    public var buffer: String
    public var exitCode: Int?
    public var error: String?
    public var hasRunningSubprocess: Bool
    public var updatedAt: String?

    public init(
        threadID: String,
        terminalID: String = "default",
        state: FeatureTerminalState = .stopped,
        title: String = "Terminal",
        workingDirectory: String? = nil,
        buffer: String = "",
        exitCode: Int? = nil,
        error: String? = nil,
        hasRunningSubprocess: Bool = false,
        updatedAt: String? = nil
    ) {
        self.threadID = threadID
        self.terminalID = terminalID
        self.state = state
        self.title = title
        self.workingDirectory = workingDirectory
        self.buffer = buffer
        self.exitCode = exitCode
        self.error = error
        self.hasRunningSubprocess = hasRunningSubprocess
        self.updatedAt = updatedAt
    }
}
