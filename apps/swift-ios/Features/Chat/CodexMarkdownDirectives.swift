import Foundation

enum CodexArtifactTemplateKind: String, Equatable, Sendable {
    case document, presentation, spreadsheet, site
    case googleDocs = "google-docs"
    case googleSlides = "google-slides"
    case googleSheets = "google-sheets"
    case image, email, slack

    var label: String {
        switch self {
        case .document: "Document template"
        case .presentation: "Presentation template"
        case .spreadsheet: "Spreadsheet template"
        case .site: "Site template"
        case .googleDocs: "Google Doc template"
        case .googleSlides: "Google Slides template"
        case .googleSheets: "Google Sheet template"
        case .image: "Image template"
        case .email: "Email template"
        case .slack: "Slack template"
        }
    }

    func usePrompt(skillName: String) -> String {
        let skill = "$\(skillName)"
        return switch self {
        case .document: "Create a document using this \(skill) about…"
        case .presentation: "Create a presentation using the \(skill) template about…"
        case .spreadsheet: "Create a spreadsheet using this \(skill) about…"
        case .site: "Create a Site using this \(skill) about…"
        case .googleDocs: "Create a Google Doc using this \(skill) about…"
        case .googleSlides: "Create a Google Slides presentation using this \(skill) about…"
        case .googleSheets: "Create a Google Sheet using this \(skill) about…"
        case .image: "Create an image using this \(skill) of…"
        case .email: "Draft an email using this \(skill) about…"
        case .slack: "Draft a Slack message using this \(skill) about…"
        }
    }
}

struct CodexArtifactTemplate: Equatable, Sendable {
    let kind: CodexArtifactTemplateKind
    let displayName: String
    let skillDirectory: String
    let skillName: String
    let galleryKind: String?

    var usePrompt: String { kind.usePrompt(skillName: skillName) }

    var useURL: URL? {
        var components = URLComponents()
        components.scheme = "t3code"
        components.host = "codex-artifact-template"
        components.path = "/use"
        components.queryItems = [URLQueryItem(name: "prompt", value: usePrompt)]
        return components.url
    }
}

enum CodexMarkdownDirectives {
    private static let artifactPrefix = "::artifact-template{"
    private static let fileCitationPrefix = ":codex-file-citation{"
    private static let fileCitationCharacters = Array(fileCitationPrefix)

    static func artifactTemplate(from line: String) -> CodexArtifactTemplate? {
        guard line.prefix(while: { $0 == " " }).count < 4, line.first != "\t" else {
            return nil
        }
        let source = line.trimmingCharacters(in: .whitespaces)
        guard source.hasPrefix(artifactPrefix), source.hasSuffix("}"),
              let attributes = attributes(
                in: String(source.dropFirst(artifactPrefix.count).dropLast())
              ),
              let kindValue = attributes["artifact_kind"],
              let kind = CodexArtifactTemplateKind(rawValue: kindValue),
              let displayName = attributes["display_name"]?.trimmingCharacters(
                in: .whitespacesAndNewlines
              ), !displayName.isEmpty,
              let directory = attributes["skill_directory"], isAbsolutePath(directory),
              let skillName = attributes["skill_name"],
              skillName.hasPrefix("artifact-template-") else { return nil }

        let gallery = attributes["gallery_kind"]
        guard gallery == nil || gallery == "imagegen" || gallery == "product-design" else {
            return nil
        }
        return CodexArtifactTemplate(
            kind: kind,
            displayName: displayName,
            skillDirectory: directory,
            skillName: skillName,
            galleryKind: gallery
        )
    }

    static func replacingFileCitations(in source: String) -> String {
        // Most messages have no citations. Keep them out of the character-by-character
        // link and code scanner, including incomplete Markdown arriving in a stream.
        guard source.contains(fileCitationPrefix) else { return source }
        let lines = source.components(separatedBy: "\n")
        var fence: Character?
        var fenceCount = 0
        return lines.map { line in
            let trimmed = line.drop(while: { $0 == " " || $0 == "\t" })
            if let marker = trimmed.first, marker == "`" || marker == "~" {
                let count = trimmed.prefix(while: { $0 == marker }).count
                if count >= 3 {
                    if fence == nil { fence = marker; fenceCount = count }
                    else if fence == marker, count >= fenceCount { fence = nil }
                    return line
                }
            }
            let leadingSpaces = line.prefix(while: { $0 == " " }).count
            guard fence == nil, leadingSpaces < 4, line.first != "\t",
                  line.contains(fileCitationPrefix) else {
                return line
            }
            return replacingCitationsInInlineMarkdown(line)
        }.joined(separator: "\n")
    }

    private static func replacingCitationsInInlineMarkdown(_ line: String) -> String {
        let characters = Array(line)
        var result = ""
        var cursor = 0

        while cursor < characters.count {
            if characters[cursor] == "[", !isEscaped(at: cursor, in: characters),
               let end = markdownLinkEnd(in: characters, from: cursor) {
                result += String(characters[cursor..<end])
                cursor = end
                continue
            }
            if characters[cursor] == "`", !isEscaped(at: cursor, in: characters) {
                let end = characters[cursor...].prefix(while: { $0 == "`" }).count + cursor
                let count = end - cursor
                if let closing = closingBacktickRun(
                    ofLength: count,
                    after: end,
                    in: characters
                ) {
                    result += String(characters[cursor..<closing])
                    cursor = closing
                    continue
                }
            }
            if characters[cursor] == ":", !isEscaped(at: cursor, in: characters),
               characters[cursor...].starts(with: fileCitationCharacters),
               let closing = directiveEnd(in: characters, from: cursor) {
                let directive = String(characters[cursor...closing])
                if let replacement = fileCitation(from: directive) {
                    result += replacement
                    cursor = closing + 1
                    continue
                }
            }
            result.append(characters[cursor]); cursor += 1
        }
        return result
    }

    static func fileCitation(from directive: String) -> String? {
        let prefix = fileCitationPrefix
        guard directive.hasPrefix(prefix), directive.hasSuffix("}"),
              let values = attributes(in: String(directive.dropFirst(prefix.count).dropLast())),
              let rawPath = values["path"] else { return nil }
        let path = rawPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty else { return nil }
        let normalizedPath = path.replacingOccurrences(of: "\\", with: "/")
            .replacingOccurrences(of: #"/+$"#, with: "", options: .regularExpression)
        let label = normalizedPath.split(separator: "/").last.map(String.init)
            ?? (normalizedPath.isEmpty ? "File" : normalizedPath)
        var destination = path
            .replacingOccurrences(of: "%", with: "%25")
            .replacingOccurrences(of: "#", with: "%23")
            .replacingOccurrences(of: "?", with: "%3F")
            .replacingOccurrences(of: "<", with: "%3C")
            .replacingOccurrences(of: ">", with: "%3E")
            .replacingOccurrences(of: "\r", with: "%0D")
            .replacingOccurrences(of: "\n", with: "%0A")
        if let line = values["line_range_start"],
           let value = Int(line.trimmingCharacters(in: .whitespacesAndNewlines)), value > 0 {
            destination += "#L\(value)"
        }
        return "[\(escapedMarkdownLabel(label))](<\(destination)>)"
    }

    private static func attributes(in source: String) -> [String: String]? {
        let chars = Array(source)
        var values: [String: String] = [:]
        var cursor = 0
        while cursor < chars.count {
            while cursor < chars.count, chars[cursor].isWhitespace { cursor += 1 }
            guard cursor < chars.count else { break }
            let keyStart = cursor
            while cursor < chars.count, chars[cursor].isLetter || chars[cursor].isNumber
                    || chars[cursor] == "_" { cursor += 1 }
            guard cursor > keyStart else { return nil }
            let key = String(chars[keyStart..<cursor])
            while cursor < chars.count, chars[cursor].isWhitespace { cursor += 1 }
            guard cursor < chars.count, chars[cursor] == "=" else { return nil }
            cursor += 1
            while cursor < chars.count, chars[cursor].isWhitespace { cursor += 1 }
            guard cursor < chars.count else { return nil }
            let quote: Character? = chars[cursor] == "\"" || chars[cursor] == "'"
                ? chars[cursor]
                : nil
            if quote != nil { cursor += 1 }
            var value = ""
            while cursor < chars.count,
                  quote == nil ? !chars[cursor].isWhitespace : chars[cursor] != quote {
                if chars[cursor] == "\\", cursor + 1 < chars.count,
                   chars[cursor + 1] == quote || chars[cursor + 1] == "\\" {
                    cursor += 1
                }
                value.append(chars[cursor]); cursor += 1
            }
            guard !value.isEmpty else { return nil }
            if quote != nil {
                guard cursor < chars.count else { return nil }
                cursor += 1
            }
            guard values.updateValue(value, forKey: key) == nil else { return nil }
        }
        return values
    }

    private static func markdownLinkEnd(in chars: [Character], from start: Int) -> Int? {
        guard let labelEnd = closingBracket(in: chars, from: start) else { return nil }
        let suffix = labelEnd + 1
        guard suffix < chars.count else { return nil }
        if chars[suffix] == "(" {
            return closingDelimiter(")", in: chars, after: suffix)
        }
        if chars[suffix] == "[" {
            return closingBracket(in: chars, from: suffix).map { $0 + 1 }
        }
        return nil
    }

    private static func closingBracket(in chars: [Character], from start: Int) -> Int? {
        var depth = 1
        var cursor = start + 1
        while cursor < chars.count {
            if !isEscaped(at: cursor, in: chars) {
                if chars[cursor] == "[" { depth += 1 }
                if chars[cursor] == "]" {
                    depth -= 1
                    if depth == 0 { return cursor }
                }
            }
            cursor += 1
        }
        return nil
    }

    private static func closingDelimiter(
        _ delimiter: Character,
        in chars: [Character],
        after start: Int
    ) -> Int? {
        var cursor = start + 1
        while cursor < chars.count {
            if chars[cursor] == delimiter, !isEscaped(at: cursor, in: chars) { return cursor + 1 }
            cursor += 1
        }
        return nil
    }

    private static func closingBacktickRun(
        ofLength length: Int,
        after start: Int,
        in chars: [Character]
    ) -> Int? {
        var cursor = start
        while cursor < chars.count {
            guard chars[cursor] == "`", !isEscaped(at: cursor, in: chars) else {
                cursor += 1
                continue
            }
            let end = chars[cursor...].prefix(while: { $0 == "`" }).count + cursor
            if end - cursor == length { return end }
            cursor = end
        }
        return nil
    }

    private static func directiveEnd(in chars: [Character], from start: Int) -> Int? {
        var cursor = start + fileCitationCharacters.count
        var quote: Character?
        while cursor < chars.count {
            let character = chars[cursor]
            if let activeQuote = quote {
                if character == activeQuote, !isEscaped(at: cursor, in: chars) { quote = nil }
            } else if character == "\"" || character == "'" {
                quote = character
            } else if character == "}" {
                return cursor
            }
            cursor += 1
        }
        return nil
    }

    private static func isEscaped(at index: Int, in chars: [Character]) -> Bool {
        guard index > 0 else { return false }
        var backslashes = 0
        var cursor = index - 1
        while chars[cursor] == "\\" {
            backslashes += 1
            guard cursor > 0 else { break }
            cursor -= 1
        }
        return backslashes.isMultiple(of: 2) == false
    }

    private static func escapedMarkdownLabel(_ value: String) -> String {
        let escaped = CharacterSet(charactersIn: "\\[]*_`<&")
        return value.unicodeScalars.reduce(into: "") { result, scalar in
            if escaped.contains(scalar) { result.append("\\") }
            result.unicodeScalars.append(scalar)
        }
    }

    private static func isAbsolutePath(_ path: String) -> Bool {
        if path.hasPrefix("/"), !path.hasPrefix("//") { return true }
        if path.range(of: #"^[A-Za-z]:[\\/]"#, options: .regularExpression) != nil { return true }
        return path.range(of: #"^(?:\\\\[^\\]+\\[^\\]+|//[^/]+/[^/]+)"#,
                          options: .regularExpression) != nil
    }
}
