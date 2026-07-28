import Foundation
import SwiftUI

struct FileLinkTarget: Equatable, Hashable, Sendable {
    let path: String
    let line: Int?

    var displayName: String {
        let name = (path as NSString).lastPathComponent
        guard let line else { return name }
        return "\(name):\(line)"
    }
}

private let fileLinkScheme = "sergecode-file"
private let pathComponentAllowedCharacters = CharacterSet.alphanumerics.union(
    CharacterSet(charactersIn: "-._~"))

private let plainFilePathExpression = try! NSRegularExpression(
    pattern: #"/?(?:[\w.@+-]+/)+[\w.@+-]+\.[A-Za-z0-9]{1,16}(?:(?::\d+(?::\d+)?(?:-\d+)?)|(?:#L\d+(?:C\d+)?(?:-L?\d+)?))?|(?<![\w.@+-])[\w@+-]+\.(?:swift|tsx|ts|jsx|js|mjs|cjs|json|mdx|md|py|rb|rs|go|java|kts|kt|cpp|cc|c|hpp|h|mm|m|cs|sh|zsh|fish|sql|toml|yaml|yml|xml|html|scss|css|vue|svelte)(?:(?::\d+(?::\d+)?(?:-\d+)?)|(?:#L\d+(?:C\d+)?(?:-L?\d+)?))?"#,
    options: [.caseInsensitive])
private let inlineCodeFilePathExpression = try! NSRegularExpression(
    pattern: #"^(?:(?:/?(?:[\w.@+ -]+/)*[\w.@+ -]+\.[A-Za-z0-9]{1,16})|(?:(?:[\w.@+ -]+/)*(?:AGENTS|README|LICENSE|Makefile|Dockerfile|Gemfile|Rakefile|Justfile)))(?:(?::\d+(?::\d+)?(?:-\d+)?)|(?:#L\d+(?:C\d+)?(?:-L?\d+)?))?$"#,
    options: [.caseInsensitive])
// Non-greedy path group so `file.ts:3:7` yields path `file.ts`, line 3
// (greedy `(.*)` would swallow `:3` into the path and report line 7).
private let lineSuffixExpression = try! NSRegularExpression(
    pattern: #"^(.*?):(\d+)(?::\d+)?(?:-\d+)?$"#)
private let fragmentLineSuffixExpression = try! NSRegularExpression(
    pattern: #"^(.*?)#L(\d+)(?:C\d+)?(?:-L?\d+)?$"#,
    options: [.caseInsensitive])

func fileLinkURL(path: String, line: Int?) -> URL? {
    guard !path.isEmpty,
          let encodedPath = path.addingPercentEncoding(
              withAllowedCharacters: pathComponentAllowedCharacters)
    else { return nil }
    let fragment = line.map { "#L\($0)" } ?? ""
    return URL(string: "\(fileLinkScheme):///\(encodedPath)\(fragment)")
}

func parseFileLinkURL(_ url: URL) -> FileLinkTarget? {
    guard url.scheme?.lowercased() == fileLinkScheme,
          url.host == nil || url.host?.isEmpty == true
    else { return nil }

    let encodedPath = url.path(percentEncoded: true)
    guard encodedPath.hasPrefix("/"),
          let path = String(encodedPath.dropFirst()).removingPercentEncoding,
          !path.isEmpty
    else { return nil }

    let line: Int?
    if let fragment = url.fragment {
        guard fragment.hasPrefix("L"), let parsed = Int(fragment.dropFirst()) else { return nil }
        line = parsed
    } else {
        line = nil
    }
    return FileLinkTarget(path: path, line: line)
}

/// Converts a Markdown link destination into the same internal target used by
/// auto-linkified paths. Agent output commonly uses relative destinations
/// (`[AppModel.swift](apps/mac/…/AppModel.swift#L40)`), which `URL(string:)`
/// accepts but the system cannot open meaningfully. HTTP/mail links stay
/// external; local file URLs and workspace-relative paths become SergeCode
/// links so click and contextual open actions share one route.
func fileTarget(fromMarkdownDestination destination: String) -> FileLinkTarget? {
    var candidate = destination.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !candidate.isEmpty else { return nil }

    if candidate.hasPrefix("<"), candidate.hasSuffix(">") {
        candidate.removeFirst()
        candidate.removeLast()
    }

    if let url = URL(string: candidate), let scheme = url.scheme?.lowercased() {
        if scheme == fileLinkScheme {
            return parseFileLinkURL(url)
        }
        if scheme == "file" {
            return fileTarget(from: url.path(percentEncoded: false)
                + url.fragment.map { "#\($0)" }.orEmpty)
        }
        return nil
    }

    guard !candidate.hasPrefix("#"),
        candidate.contains("/") || looksLikeFileName(candidate)
    else { return nil }
    return fileTarget(from: candidate)
}

/// Produces the server launcher's target. Code editors understand
/// `path:line`; Finder must receive the real filesystem path without a
/// position suffix.
func editorSubpath(for target: FileLinkTarget, editor: ExternalEditor) -> String {
    guard editor != .fileManager, let line = target.line else { return target.path }
    return "\(target.path):\(line)"
}

func linkifyFilePaths(in attributed: AttributedString) -> AttributedString {
    var result = attributed

    for run in attributed.runs where run.link == nil {
        let text = String(attributed.characters[run.range])
        let matches: [NSTextCheckingResult]
        if run.inlinePresentationIntent?.contains(.code) == true {
            let fullRange = NSRange(text.startIndex..<text.endIndex, in: text)
            matches = inlineCodeFilePathExpression.firstMatch(
                in: text, range: fullRange).map { [$0] } ?? []
        } else {
            let fullRange = NSRange(text.startIndex..<text.endIndex, in: text)
            matches = plainFilePathExpression.matches(in: text, range: fullRange)
        }

        for match in matches {
            guard let stringRange = Range(match.range, in: text),
                  !isHTTPToken(at: stringRange, in: text),
                  let target = fileTarget(from: String(text[stringRange])),
                  let url = fileLinkURL(path: target.path, line: target.line)
            else { continue }

            let lowerOffset = text.distance(from: text.startIndex, to: stringRange.lowerBound)
            let upperOffset = text.distance(from: text.startIndex, to: stringRange.upperBound)
            let lower = result.characters.index(run.range.lowerBound, offsetBy: lowerOffset)
            let upper = result.characters.index(run.range.lowerBound, offsetBy: upperOffset)
            let range = lower..<upper
            result[range].link = url
            result[range].foregroundColor = AlpineTheme.accent
            result[range].underlineStyle = .single
        }
    }

    return result
}

private func fileTarget(from token: String) -> FileLinkTarget? {
    let token = token.trimmingCharacters(
        in: CharacterSet(charactersIn: " \t\r\n\"'`()[]{}<>,.;"))
    let fullRange = NSRange(token.startIndex..<token.endIndex, in: token)
    if let match = fragmentLineSuffixExpression.firstMatch(in: token, range: fullRange),
        let pathRange = Range(match.range(at: 1), in: token),
        let lineRange = Range(match.range(at: 2), in: token),
        let line = Int(token[lineRange])
    {
        return FileLinkTarget(path: String(token[pathRange]), line: line)
    }
    guard let match = lineSuffixExpression.firstMatch(in: token, range: fullRange),
          let pathRange = Range(match.range(at: 1), in: token),
          let lineRange = Range(match.range(at: 2), in: token),
          let line = Int(token[lineRange])
    else {
        return FileLinkTarget(path: token, line: nil)
    }
    return FileLinkTarget(path: String(token[pathRange]), line: line)
}

private func looksLikeFileName(_ value: String) -> Bool {
    let path = value
        .split(separator: "#", maxSplits: 1).first
        .map(String.init) ?? value
    let withoutLocation = path.replacingOccurrences(
        of: #":\d+(?::\d+)?$"#, with: "", options: .regularExpression)
    let name = (withoutLocation as NSString).lastPathComponent
    guard let dot = name.lastIndex(of: "."), dot != name.startIndex else { return false }
    let ext = name[name.index(after: dot)...]
    return !ext.isEmpty && ext.count <= 16
}

private func isHTTPToken(at matchRange: Range<String.Index>, in text: String) -> Bool {
    var tokenStart = matchRange.lowerBound
    while tokenStart > text.startIndex {
        let previous = text.index(before: tokenStart)
        guard !text[previous].isWhitespace else { break }
        tokenStart = previous
    }
    let prefix = text[tokenStart..<matchRange.upperBound]
        .drop(while: { "([<\"'".contains($0) })
        .lowercased()
    // Only skip real URLs — repo paths like `httpserver/config.ts` or
    // `http-client/main.go` merely start with "http".
    return prefix.hasPrefix("http://") || prefix.hasPrefix("https://")
}

private extension Optional where Wrapped == String {
    var orEmpty: String { self ?? "" }
}
