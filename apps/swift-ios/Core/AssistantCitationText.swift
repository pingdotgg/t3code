import Foundation

/// Queue previews expand citations for reading; editing and sending retain the original links.
enum AssistantCitationText {
    private static let pattern = try! NSRegularExpression(pattern: #"\[Assistant quote\]\((t3-citation://v1/[^\s)]{1,160000})\)"#)

    static func plainText(_ source: String) -> String {
        var result = source
        for match in pattern.matches(in: source, range: NSRange(source.startIndex..., in: source)).reversed() {
            guard let hrefRange = Range(match.range(at: 1), in: source),
                  let range = Range(match.range, in: result),
                  let replacement = expansion(String(source[hrefRange])) else { continue }
            result.replaceSubrange(range, with: replacement)
        }
        return result
    }

    private static func expansion(_ href: String) -> String? {
        guard var url = URLComponents(string: href) else { return nil }
        url.percentEncodedQuery = url.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%20")
        let path = url.path.split(separator: "/", omittingEmptySubsequences: false).dropFirst()
        guard url.scheme == "t3-citation", url.host == "v1",
              url.user == nil, url.password == nil, url.port == nil, url.fragment == nil,
              path.count == 3,
              path.allSatisfy({ !$0.isEmpty && $0.utf16.count <= 512 }),
              let items = url.queryItems else { return nil }
        let required = Set(["text", "start", "end", "prefix", "suffix"])
        let keys = items.map(\.name)
        guard Set(keys).isSuperset(of: required), Set(keys).isSubset(of: required.union(["comment"])),
              Set(keys).count == keys.count else { return nil }
        let values = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
        guard let text = values["text"], !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              text.utf16.count <= 8000, (values["comment"]?.utf16.count ?? 0) <= 8000,
              (values["prefix"]?.utf16.count ?? 0) <= 32, (values["suffix"]?.utf16.count ?? 0) <= 32,
              let start = offset(values["start"]), let end = offset(values["end"]), end > start else { return nil }
        return values["comment"].map { text + "\nComment: " + $0 } ?? text
    }

    private static func offset(_ value: String?) -> Int64? {
        guard let value, !value.isEmpty, value.count <= 16,
              value.allSatisfy({ $0.isASCII && $0.isNumber }),
              let number = Int64(value), number <= 9_007_199_254_740_991 else { return nil }
        return number
    }
}
