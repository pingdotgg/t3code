import Foundation

// Lightweight hand-rolled tokenizer for subtle syntax tinting in the diff
// review. No dependencies — regex + keyword sets only. Off-render-path safe.

public enum SyntaxLanguage: Sendable, Equatable {
    case swift
    case typescript  // also covers JavaScript
    case json
    case plain

    public static func language(forPath path: String) -> SyntaxLanguage {
        let ext = (path as NSString).pathExtension.lowercased()
        switch ext {
        case "swift": return .swift
        case "ts", "tsx", "js", "jsx", "mjs", "cjs": return .typescript
        case "json": return .json
        default: return .plain
        }
    }
}

public enum SyntaxKind: String, Sendable, Equatable {
    case plain
    case keyword
    case string
    case comment
    case number
}

public struct SyntaxSpan: Equatable, Sendable, Hashable {
    public var text: String
    public var kind: SyntaxKind

    public init(text: String, kind: SyntaxKind) {
        self.text = text
        self.kind = kind
    }
}

public enum SyntaxTint: Sendable {
    public static func tokenize(_ text: String, language: SyntaxLanguage) -> [SyntaxSpan] {
        guard !text.isEmpty else { return [] }
        switch language {
        case .plain:
            return [SyntaxSpan(text: text, kind: .plain)]
        case .json:
            return tokenizeJSON(text)
        case .swift, .typescript:
            return tokenizeCode(text, keywords: keywords(for: language))
        }
    }

    // MARK: - Keywords

    private static func keywords(for language: SyntaxLanguage) -> Set<String> {
        switch language {
        case .swift:
            return [
                "associatedtype", "class", "deinit", "enum", "extension", "fileprivate",
                "func", "import", "init", "inout", "internal", "let", "open", "operator",
                "private", "protocol", "public", "rethrows", "static", "struct",
                "subscript", "typealias", "var", "break", "case", "continue", "default",
                "defer", "do", "else", "fallthrough", "for", "guard", "if", "in",
                "repeat", "return", "switch", "where", "while", "as", "Any", "catch",
                "false", "is", "nil", "super", "self", "Self", "throw", "throws",
                "true", "try", "async", "await", "actor", "some", "any", "borrowing",
                "consuming", "nonisolated", "isolated", "package", "macro",
            ]
        case .typescript:
            return [
                "break", "case", "catch", "class", "const", "continue", "debugger",
                "default", "delete", "do", "else", "export", "extends", "false",
                "finally", "for", "function", "if", "import", "in", "instanceof",
                "let", "new", "null", "return", "super", "switch", "this", "throw",
                "true", "try", "typeof", "var", "void", "while", "with", "yield",
                "async", "await", "from", "of", "as", "interface", "type", "enum",
                "implements", "private", "public", "protected", "readonly", "static",
                "abstract", "namespace", "module", "declare", "keyof", "infer",
                "never", "unknown", "any", "boolean", "number", "string", "symbol",
            ]
        case .json, .plain:
            return []
        }
    }

    // MARK: - Code (swift / ts)

    private static func tokenizeCode(_ text: String, keywords: Set<String>) -> [SyntaxSpan] {
        var spans: [SyntaxSpan] = []
        var i = text.startIndex

        while i < text.endIndex {
            // Line comment //
            if text[i...].hasPrefix("//") {
                spans.append(SyntaxSpan(text: String(text[i...]), kind: .comment))
                break
            }
            // Block comment start /*
            if text[i...].hasPrefix("/*") {
                if let end = text.range(of: "*/", range: i..<text.endIndex) {
                    let endIdx = end.upperBound
                    spans.append(SyntaxSpan(text: String(text[i..<endIdx]), kind: .comment))
                    i = endIdx
                    continue
                } else {
                    spans.append(SyntaxSpan(text: String(text[i...]), kind: .comment))
                    break
                }
            }
            // String (simple "..." or '...' or `...` with escapes)
            if text[i] == "\"" || text[i] == "'" || text[i] == "`" {
                let quote = text[i]
                var j = text.index(after: i)
                var escaped = false
                while j < text.endIndex {
                    let ch = text[j]
                    if escaped {
                        escaped = false
                    } else if ch == "\\" {
                        escaped = true
                    } else if ch == quote {
                        j = text.index(after: j)
                        break
                    }
                    j = text.index(after: j)
                }
                spans.append(SyntaxSpan(text: String(text[i..<j]), kind: .string))
                i = j
                continue
            }
            // Number
            if text[i].isNumber {
                var j = i
                while j < text.endIndex && (text[j].isNumber || text[j] == "." || text[j] == "_") {
                    j = text.index(after: j)
                }
                spans.append(SyntaxSpan(text: String(text[i..<j]), kind: .number))
                i = j
                continue
            }
            // Identifier / keyword
            if text[i].isLetter || text[i] == "_" {
                var j = i
                while j < text.endIndex && (text[j].isLetter || text[j].isNumber || text[j] == "_") {
                    j = text.index(after: j)
                }
                let word = String(text[i..<j])
                let kind: SyntaxKind = keywords.contains(word) ? .keyword : .plain
                spans.append(SyntaxSpan(text: word, kind: kind))
                i = j
                continue
            }
            // Single non-word char (or run of punctuation/whitespace)
            var j = text.index(after: i)
            while j < text.endIndex {
                let ch = text[j]
                if ch.isLetter || ch.isNumber || ch == "_" || ch == "\"" || ch == "'"
                    || ch == "`" || ch == "/"
                {
                    break
                }
                j = text.index(after: j)
            }
            // But stop at // or /* boundaries inside the run
            let chunk = String(text[i..<j])
            if let slash = chunk.range(of: "//") ?? chunk.range(of: "/*") {
                let before = String(chunk[..<slash.lowerBound])
                if !before.isEmpty {
                    spans.append(SyntaxSpan(text: before, kind: .plain))
                }
                i = text.index(i, offsetBy: before.count)
                continue
            }
            spans.append(SyntaxSpan(text: chunk, kind: .plain))
            i = j
        }

        return mergeAdjacentPlain(spans)
    }

    // MARK: - JSON

    private static func tokenizeJSON(_ text: String) -> [SyntaxSpan] {
        var spans: [SyntaxSpan] = []
        var i = text.startIndex
        let keywords: Set<String> = ["true", "false", "null"]

        while i < text.endIndex {
            if text[i] == "\"" {
                var j = text.index(after: i)
                var escaped = false
                while j < text.endIndex {
                    if escaped {
                        escaped = false
                    } else if text[j] == "\\" {
                        escaped = true
                    } else if text[j] == "\"" {
                        j = text.index(after: j)
                        break
                    }
                    j = text.index(after: j)
                }
                spans.append(SyntaxSpan(text: String(text[i..<j]), kind: .string))
                i = j
                continue
            }
            if text[i].isNumber || (text[i] == "-" && text.index(after: i) < text.endIndex
                && text[text.index(after: i)].isNumber)
            {
                var j = i
                if text[j] == "-" { j = text.index(after: j) }
                while j < text.endIndex
                    && (text[j].isNumber || text[j] == "." || text[j] == "e" || text[j] == "E"
                        || text[j] == "+" || text[j] == "-")
                {
                    j = text.index(after: j)
                }
                spans.append(SyntaxSpan(text: String(text[i..<j]), kind: .number))
                i = j
                continue
            }
            if text[i].isLetter {
                var j = i
                while j < text.endIndex && text[j].isLetter {
                    j = text.index(after: j)
                }
                let word = String(text[i..<j])
                spans.append(
                    SyntaxSpan(text: word, kind: keywords.contains(word) ? .keyword : .plain))
                i = j
                continue
            }
            let j = text.index(after: i)
            spans.append(SyntaxSpan(text: String(text[i..<j]), kind: .plain))
            i = j
        }
        return mergeAdjacentPlain(spans)
    }

    private static func mergeAdjacentPlain(_ spans: [SyntaxSpan]) -> [SyntaxSpan] {
        guard !spans.isEmpty else { return [] }
        var result: [SyntaxSpan] = []
        for span in spans {
            if span.kind == .plain, let last = result.last, last.kind == .plain {
                result[result.count - 1] = SyntaxSpan(text: last.text + span.text, kind: .plain)
            } else {
                result.append(span)
            }
        }
        return result
    }
}
