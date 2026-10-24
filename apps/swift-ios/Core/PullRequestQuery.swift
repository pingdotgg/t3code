import Foundation

public struct PullRequestQuery: Equatable, Sendable {
    public let text: String
    public let filters: PullRequestListFilters

    public init(_ query: String) {
        var text: [String] = []
        var labels: [[String]] = []
        var excludedLabels: [String] = []
        var author: String?
        var draft: String?
        var review: String?
        var checks: String?
        for token in Self.tokens(query) {
            guard let colon = token.firstIndex(of: ":") else { text.append(token); continue }
            let prefix = String(token[..<colon])
            let negated = prefix.hasPrefix("-")
            let key = String(negated ? prefix.dropFirst() : prefix[...]).lowercased()
            let raw = String(token[token.index(after: colon)...])
            let value = Self.value(raw)
            guard !value.isEmpty, key.range(of: #"^[a-z][a-z0-9_-]*$"#, options: .regularExpression) != nil else {
                text.append(token); continue
            }
            switch key {
            case "label":
                let names = Self.names(raw)
                guard !names.isEmpty else { text.append(token); continue }
                if negated { excludedLabels += names } else { labels.append(names) }
            case "author" where !negated:
                author = Self.bounded(value)
            case "draft" where !negated && ["true", "false"].contains(value.lowercased()):
                draft = value.lowercased() == "true" ? "only" : "hide"
            case "review" where !negated && Self.reviewValues[value.lowercased()] != nil:
                review = Self.reviewValues[value.lowercased()]
            case "status" where !negated && Self.checksValues[value.lowercased()] != nil,
                 "checks" where !negated && Self.checksValues[value.lowercased()] != nil:
                checks = Self.checksValues[value.lowercased()]
                if checks == nil { text.append(token) }
            case "author", "draft", "review", "status", "checks": text.append(token)
            default:
                if value.hasPrefix("/") { text.append(token) }
                else {
                    let names = Self.names(raw).map { Self.bounded($0.contains(":") ? $0 : "\(negated ? String(prefix.dropFirst()) : prefix):\($0)") }
                    guard !names.isEmpty else { text.append(token); continue }
                    if negated { excludedLabels += names } else { labels.append(names) }
                }
            }
        }
        self.text = text.joined(separator: " ")
        filters = PullRequestListFilters(draft: draft, review: review, checks: checks,
            labels: labels.isEmpty ? nil : Array(labels.prefix(10)),
            excludedLabels: excludedLabels.isEmpty ? nil : Array(excludedLabels.prefix(10)), author: author)
    }

    public static func settingDraft(_ draft: String?, in query: String) -> String {
        guard Self(query).filters.draft != draft else { return query }
        return tokens(query).filter { Self($0).filters.draft == nil }.joined(separator: " ")
    }

    private static let reviewValues = ["approved": "approved", "changes_requested": "changes-requested",
        "changes-requested": "changes-requested", "required": "review-required", "review-required": "review-required", "none": "none"]
    private static let checksValues = ["success": "passing", "passing": "passing", "failure": "failing", "failing": "failing"]
    private static func value(_ raw: String) -> String {
        raw.replacingOccurrences(of: "\"", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private static func names(_ raw: String) -> [String] {
        matches(#"(?:[^,\"]|\"[^\"]*\")+"#, in: raw).map(value).filter { !$0.isEmpty }
            .prefix(10).map(bounded).filter { !$0.isEmpty }
    }
    private static func bounded(_ value: String) -> String {
        var result = ""
        var count = 0
        for character in value {
            let size = String(character).utf16.count
            guard count + size <= 200 else { break }
            result.append(character)
            count += size
        }
        return result.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func tokens(_ raw: String) -> [String] { matches(#"(?:[^\s\"]|\"[^\"]*\")+"#, in: raw) }
    private static func matches(_ pattern: String, in raw: String) -> [String] {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        return regex.matches(in: raw, range: NSRange(raw.startIndex..., in: raw)).compactMap {
            Range($0.range, in: raw).map { String(raw[$0]) }
        }
    }
}
