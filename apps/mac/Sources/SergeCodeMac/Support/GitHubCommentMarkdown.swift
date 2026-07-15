import Foundation

/// Converts GitHub's presentation-only HTML wrappers into Markdown that the
/// native renderer can lay out. GitHub comments commonly use invisible HTML
/// comments for bot metadata and `<details>` elements for collapsible groups;
/// passing those directly to a Markdown renderer either exposes the tags or
/// causes the enclosed blocks to be flattened into a single run.
func renderableGitHubCommentMarkdown(_ source: String) -> String {
    var markdown = source

    markdown = replacingMatches(
        in: markdown,
        pattern: #"(?s)<!--[\s\S]*?-->"#,
        with: "")
    markdown = replacingMatches(
        in: markdown,
        pattern: #"(?is)<summary\b[^>]*>(.*?)</summary>"#,
        with: "\n**$1**\n")
    markdown = replacingMatches(
        in: markdown,
        pattern: #"(?is)</?details\b[^>]*>"#,
        with: "\n")
    markdown = replacingMatches(
        in: markdown,
        pattern: #"(?is)<br\s*/?>"#,
        with: "\n")
    markdown = replacingMatches(
        in: markdown,
        pattern: #"(?is)</?(?:sub|sup)\b[^>]*>"#,
        with: "")

    // GitHub alert markers are meaningful to GitHub's renderer but otherwise
    // appear as literal punctuation. Keep the alert inside its block quote and
    // turn the marker into a readable, emphasized label.
    markdown = replacingMatches(
        in: markdown,
        pattern: #"(?m)^(\s*>\s*)\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$"#,
        with: "$1**$2**")

    // Removing comment-only lines and wrapper tags can leave large empty
    // regions in bot comments. Preserve normal paragraph separation while
    // avoiding excessive vertical whitespace.
    markdown = replacingMatches(
        in: markdown,
        pattern: #"\n[\t ]*\n(?:[\t ]*\n)+"#,
        with: "\n\n")
    return markdown.trimmingCharacters(in: .whitespacesAndNewlines)
}

private func replacingMatches(in source: String, pattern: String, with template: String) -> String {
    guard let expression = try? NSRegularExpression(pattern: pattern) else { return source }
    let range = NSRange(source.startIndex..<source.endIndex, in: source)
    return expression.stringByReplacingMatches(
        in: source,
        range: range,
        withTemplate: template)
}
