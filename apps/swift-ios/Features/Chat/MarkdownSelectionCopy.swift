import Foundation
import UIKit

extension NSAttributedString.Key {
    static let markdownCopyBlock = Self("t3.markdown.copy-block")
    static let markdownInlineTraits = Self("t3.markdown.inline-traits")
    static let markdownCopyDecoration = Self("t3.markdown.copy-decoration")
}

/// Retains Markdown structure independently of UIKit fonts and selection ranges.
final class MarkdownCopyBlock: NSObject {
    enum Kind {
        case paragraph
        case heading(Int)
        case listItem(marker: String, depth: Int)
        case code(language: String?)
    }

    let kind: Kind
    let separator: String

    init(_ kind: Kind, separator: String = "\n\n") {
        self.kind = kind
        self.separator = separator
    }
}

struct MarkdownCopyTraits: OptionSet {
    let rawValue: Int
    static let bold = Self(rawValue: 1 << 0)
    static let italic = Self(rawValue: 1 << 1)
    static let strike = Self(rawValue: 1 << 2)
    static let code = Self(rawValue: 1 << 3)
}

/// Copies a selected fragment as balanced Markdown without including unselected text.
/// Markers and code headers in the display are decorations; structure is rebuilt here.
enum MarkdownSelectionCopy {
    private struct Span {
        var text: String
        let traits: MarkdownCopyTraits
        let link: URL?
    }

    static func markdown(in text: NSAttributedString, range: NSRange) -> String? {
        guard range.location != NSNotFound, range.location >= 0, range.length > 0,
              range.location <= text.length, range.length <= text.length - range.location else {
            return nil
        }
        let selected = text.attributedSubstring(from: range)
        var result = ""
        selected.enumerateAttribute(.markdownCopyBlock, in: NSRange(location: 0, length: selected.length)) { value, blockRange, _ in
            guard let block = value as? MarkdownCopyBlock else { return }
            let fragment = selected.attributedSubstring(from: blockRange)
            let spans = spans(in: fragment)
            guard !spans.isEmpty else { return }
            let body: String
            switch block.kind {
            case .paragraph:
                body = render(spans)
            case let .heading(level):
                body = String(repeating: "#", count: max(1, min(6, level))) + " " + render(spans)
            case let .listItem(marker, depth):
                let indent = String(repeating: "  ", count: max(0, depth))
                body = indent + marker + " " + render(spans).replacingOccurrences(of: "\n", with: "\n" + indent + "  ")
            case let .code(language):
                body = fencedCode(spans.map(\.text).joined(), language: language)
            }
            if !result.isEmpty { result += block.separator }
            result += body
        }
        return result.isEmpty ? nil : result
    }

    static func fencedCode(_ code: String, language: String?) -> String {
        let fence = String(repeating: "`", count: max(3, longestBacktickRun(in: code) + 1))
        let info = (language ?? "").filter { !$0.isNewline && $0 != "`" }
        return fence + info + "\n" + code + (code.hasSuffix("\n") ? "" : "\n") + fence
    }

    private static func spans(in text: NSAttributedString) -> [Span] {
        var spans: [Span] = []
        text.enumerateAttributes(in: NSRange(location: 0, length: text.length)) { attributes, range, _ in
            guard attributes[.markdownCopyDecoration] as? Bool != true else { return }
            let value = FeatureInlineSkillProjection.plainText(from: text.attributedSubstring(from: range))
            let traits = MarkdownCopyTraits(rawValue: attributes[.markdownInlineTraits] as? Int ?? 0)
            let link = attributes[.link] as? URL
            if let previous = spans.last, previous.traits == traits, previous.link == link {
                spans[spans.count - 1].text += value
            } else {
                spans.append(Span(text: value, traits: traits, link: link))
            }
        }
        return spans
    }

    // Group outer formatting first so bold text containing italics or links retains
    // balanced delimiters, including selections that start midway through a run.
    private static func render(_ spans: [Span], level: Int = 0) -> String {
        guard level < 5 else { return escape(spans.map(\.text).joined()) }
        var output = ""
        var index = 0
        while index < spans.count {
            let key = wrapper(for: spans[index], level: level)
            var end = index + 1
            while end < spans.count, wrapper(for: spans[end], level: level) == key { end += 1 }
            let group = Array(spans[index..<end])
            if key != nil, level == 4 {
                output += inlineCode(group.map(\.text).joined())
            } else {
                let content = render(group, level: level + 1)
                if let key {
                    if level == 0 {
                        let destination = key.replacingOccurrences(of: "<", with: "%3C")
                            .replacingOccurrences(of: ">", with: "%3E")
                        output += "[" + content + "](<" + destination + ">)"
                    } else {
                        let leading = String(content.prefix(while: \.isWhitespace))
                        let rest = content.dropFirst(leading.count)
                        let trailing = String(rest.reversed().prefix(while: \.isWhitespace).reversed())
                        let middle = rest.dropLast(trailing.count)
                        output += middle.isEmpty ? content : leading + key + String(middle) + key + trailing
                    }
                } else {
                    output += content
                }
            }
            index = end
        }
        return output
    }

    private static func wrapper(for span: Span, level: Int) -> String? {
        switch level {
        case 0: return span.link?.absoluteString
        case 1: return span.traits.contains(.bold) ? "**" : nil
        case 2: return span.traits.contains(.italic) ? "*" : nil
        case 3: return span.traits.contains(.strike) ? "~~" : nil
        default: return span.traits.contains(.code) ? "`" : nil
        }
    }

    private static func inlineCode(_ text: String) -> String {
        let fence = String(repeating: "`", count: longestBacktickRun(in: text) + 1)
        let needsPadding = text.hasPrefix("`") || text.hasSuffix("`")
            || (text.hasPrefix(" ") && text.hasSuffix(" ") && text.contains(where: { $0 != " " }))
        let padding = needsPadding ? " " : ""
        return fence + padding + text + padding + fence
    }

    private static func longestBacktickRun(in text: String) -> Int {
        text.split(whereSeparator: { $0 != "`" }).map(\.count).max() ?? 0
    }

    private static func escape(_ text: String) -> String {
        let punctuation: Set<Character> = ["\\", "`", "*", "_", "[", "]", "<", ">", "~", "|"]
        let escaped = text.map { punctuation.contains($0) ? "\\" + String($0) : String($0) }.joined()
        return escaped.replacingOccurrences(of: #"(?m)^( {0,3})([#=+\-])"#, with: #"$1\\$2"#, options: .regularExpression)
            .replacingOccurrences(of: #"(?m)^( {0,3}\d+)([.)])(?=\s)"#, with: #"$1\\$2"#, options: .regularExpression)
    }
}
