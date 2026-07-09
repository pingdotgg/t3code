import Foundation
import SwiftUI

struct FileLinkTarget: Equatable, Sendable {
    let path: String
    let line: Int?
}

private let fileLinkScheme = "sergecode-file"
private let pathComponentAllowedCharacters = CharacterSet.alphanumerics.union(
    CharacterSet(charactersIn: "-._~"))

private let plainFilePathExpression = try! NSRegularExpression(
    pattern: #"/?(?:[\w.@+-]+/)+[\w.@+-]+\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?"#)
private let inlineCodeFilePathExpression = try! NSRegularExpression(
    pattern: #"^(?:/?(?:[\w.@+-]+/)+[\w.@+-]+\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?|[\w.@+-]+\.[A-Za-z0-9]{1,8}:\d+(?::\d+)?)$"#)
// Non-greedy path group so `file.ts:3:7` yields path `file.ts`, line 3
// (greedy `(.*)` would swallow `:3` into the path and report line 7).
private let lineSuffixExpression = try! NSRegularExpression(
    pattern: #"^(.*?):(\d+)(?::\d+)?$"#)

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
            result[range].foregroundColor = .accentColor
            result[range].underlineStyle = .single
        }
    }

    return result
}

private func fileTarget(from token: String) -> FileLinkTarget? {
    let fullRange = NSRange(token.startIndex..<token.endIndex, in: token)
    guard let match = lineSuffixExpression.firstMatch(in: token, range: fullRange),
          let pathRange = Range(match.range(at: 1), in: token),
          let lineRange = Range(match.range(at: 2), in: token),
          let line = Int(token[lineRange])
    else {
        return FileLinkTarget(path: token, line: nil)
    }
    return FileLinkTarget(path: String(token[pathRange]), line: line)
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
    return prefix.hasPrefix("http")
}
