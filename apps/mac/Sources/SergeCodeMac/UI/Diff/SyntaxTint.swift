import Foundation

// Lightweight hand-rolled tokenizer for subtle syntax tinting in the diff
// review. No dependencies — regex + keyword sets only. Off-render-path safe.

public enum SyntaxLanguage: Sendable, Equatable {
    case swift
    case typescript  // also covers JavaScript
    case json
    case hashComment // Python, Ruby, shell, YAML, TOML
    case cFamily // C/C++, C#, Java, Kotlin, Go, Rust, PHP
    case plain

    public static func language(forPath path: String) -> SyntaxLanguage {
        let ext = (path as NSString).pathExtension.lowercased()
        switch ext {
        case "swift": return .swift
        case "ts", "tsx", "js", "jsx", "mjs", "cjs": return .typescript
        case "json": return .json
        case "py", "pyw", "rb", "rake", "sh", "bash", "zsh", "fish",
            "yaml", "yml", "toml":
            return .hashComment
        case "c", "h", "cc", "cpp", "cxx", "hh", "hpp", "cs", "java", "kt", "kts",
            "go", "rs", "php", "phtml", "m", "mm":
            return .cFamily
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
        case .hashComment:
            return tokenizeHashComment(text, keywords: keywords(for: language))
        case .swift, .typescript, .cFamily:
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
        case .hashComment:
            return [
                "and", "as", "assert", "async", "await", "break", "case", "class", "def",
                "elif", "else", "end", "except", "False", "finally", "for", "from",
                "function", "if", "import", "in", "is", "lambda", "local", "match",
                "module", "None", "not", "or", "pass", "raise", "readonly", "require",
                "return", "set", "source", "then", "True", "try", "unless", "until",
                "when", "while", "with", "yield", "do", "done", "export", "fi", "esac",
                "true", "false", "null",
            ]
        case .cFamily:
            return [
                "alignas", "alignof", "and", "asm", "auto", "await", "bool", "break",
                "by", "case", "catch", "chan", "char", "class", " companion", "const",
                "constexpr", "continue", "crate", "data", "default", "defer", "delete",
                "do", "double", "dyn", "else", "enum", "echo", "except", "export",
                "extends", "extern", "false", "final", "finally", "float", "for",
                "foreach", "friend", "fn", "func", "fun", "function", "go", "goto", "if",
                "implements", "impl", "import", "in", "include", "inline", "instanceof",
                "int", "interface", "is", "lateinit", "let", "long", "loop", "map",
                "match", "mod", "move", "mut", "namespace", "native", "new", "noexcept",
                "null", "nullptr", "object", "open", "operator", "override", "package",
                "private", "protected", "pub", "public", "range", "ref", "register",
                "reinterpret_cast", "return", "sealed", "select", "self", "Self", "short",
                "signed", "sizeof", "static", "struct", "super", "switch", "synchronized",
                "template", "this", "throw", "throws", "trait", "transient", "true", "try",
                "typedef", "type", "typename", "union", "unsigned", "use", "using", "val",
                "var", "virtual", "void", "volatile", "when", "where", "while", "with",
                "yield", "mut", "fn", "pub", "crate",
            ]
        case .json, .plain:
            return []
        }
    }

    // MARK: - Code (Swift / TS / C-family)

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

    // MARK: - Hash-comment languages

    private static func tokenizeHashComment(_ text: String, keywords: Set<String>) -> [SyntaxSpan] {
        var spans: [SyntaxSpan] = []
        var i = text.startIndex

        while i < text.endIndex {
            if text[i] == "#" {
                spans.append(SyntaxSpan(text: String(text[i...]), kind: .comment))
                break
            }
            if text[i] == "\"" || text[i] == "'" || text[i] == "`" {
                let quote = text[i]
                let triple = text[i...].hasPrefix(String(repeating: quote, count: 3))
                var j = text.index(i, offsetBy: triple ? 3 : 1)
                var escaped = false
                let terminator = String(repeating: quote, count: triple ? 3 : 1)
                while j < text.endIndex {
                    if !triple && escaped {
                        escaped = false
                    } else if !triple && text[j] == "\\" {
                        escaped = true
                    } else if text[j...].hasPrefix(terminator) {
                        j = text.index(j, offsetBy: terminator.count)
                        break
                    }
                    j = text.index(after: j)
                }
                spans.append(SyntaxSpan(text: String(text[i..<j]), kind: .string))
                i = j
                continue
            }
            if text[i].isNumber {
                var j = i
                while j < text.endIndex && (text[j].isNumber || text[j] == "." || text[j] == "_") {
                    j = text.index(after: j)
                }
                spans.append(SyntaxSpan(text: String(text[i..<j]), kind: .number))
                i = j
                continue
            }
            if text[i].isLetter || text[i] == "_" {
                var j = i
                while j < text.endIndex && (text[j].isLetter || text[j].isNumber || text[j] == "_") {
                    j = text.index(after: j)
                }
                let word = String(text[i..<j])
                spans.append(
                    SyntaxSpan(text: word, kind: keywords.contains(word) ? .keyword : .plain))
                i = j
                continue
            }
            var j = text.index(after: i)
            while j < text.endIndex {
                let ch = text[j]
                if ch.isLetter || ch.isNumber || ch == "_" || ch == "\"" || ch == "'"
                    || ch == "`" || ch == "#"
                {
                    break
                }
                j = text.index(after: j)
            }
            spans.append(SyntaxSpan(text: String(text[i..<j]), kind: .plain))
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
