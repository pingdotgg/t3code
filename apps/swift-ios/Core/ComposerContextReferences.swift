import Foundation

/// Matches packages/shared/src/composerContextReferences.ts. Labels are never identities.
public enum ComposerContextReferences {
    public struct Reference: Equatable, Sendable {
        public let kind: String
        public let contextId: String
        public let label: String
        public let image: Bool
        public let range: NSRange
    }

    private static let expression = try! NSRegularExpression(
        pattern: #"(!?)\[([^\]\n]{0,512})\]\((t3-context://v1/[^\s)]{1,200})\)"#
    )

    public static func parseHref(_ href: String) -> (kind: String, contextId: String)? {
        guard href.hasPrefix("t3-context://v1/") else { return nil }
        let parts = href.dropFirst("t3-context://v1/".count).split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 2,
              parts[0].range(of: #"^[a-z][a-z0-9-]{0,39}$"#, options: .regularExpression) != nil,
              parts[1].range(of: #"^[a-zA-Z0-9_-]{1,128}$"#, options: .regularExpression) != nil else { return nil }
        return (String(parts[0]), String(parts[1]))
    }

    public static func sanitizeLabel(_ label: String, kind: String) -> String {
        let clean = label.replacingOccurrences(of: #"[\[\]\\\r\n]"#, with: " ", options: .regularExpression)
            .split(whereSeparator: \.isWhitespace).joined(separator: " ")
        let bounded = String(decoding: clean.utf16.prefix(200), as: UTF16.self)
        return bounded.isEmpty ? kind : bounded
    }

    public static func format(_ record: ComposerContextRecord) -> String {
        "\(record.kind == "image" ? "!" : "")[\(sanitizeLabel(record.label, kind: record.kind))](t3-context://v1/\(record.kind)/\(record.contextId))"
    }

    public static func collect(_ text: String) -> [Reference] {
        guard text.contains("](t3-context:") else { return [] }
        let source = text as NSString
        return expression.matches(in: text, range: NSRange(location: 0, length: source.length)).compactMap { match in
            guard let parsed = parseHref(source.substring(with: match.range(at: 3))) else { return nil }
            return Reference(
                kind: parsed.kind, contextId: parsed.contextId,
                label: sanitizeLabel(source.substring(with: match.range(at: 2)), kind: parsed.kind),
                image: match.range(at: 1).length > 0, range: match.range
            )
        }
    }

    public static func replace(_ text: String, with replacement: (Reference) -> String) -> String {
        let result = NSMutableString(string: text)
        for reference in collect(text).reversed() {
            result.replaceCharacters(in: reference.range, with: replacement(reference))
        }
        return result as String
    }

    public static func displayText(_ text: String) -> String {
        replace(text) { $0.label }
    }

    public static func ensureReferences(_ text: String, records: [ComposerContextRecord]) -> String {
        var referenced = Set(collect(text).map(\.contextId))
        var result = text
        for record in records where referenced.insert(record.contextId).inserted {
            if let last = result.last, !last.isWhitespace { result += " " }
            result += format(record) + " "
        }
        return result
    }

    /// Keep linked records and annotation screenshots, including unknown kinds.
    public static func referenced(_ context: OrchestrationMessageContext?, text: String) -> OrchestrationMessageContext? {
        guard let context else { return nil }
        var ids = Set(collect(text).map(\.contextId))
        for record in context.records where ids.contains(record.contextId) {
            if case let .previewAnnotation(value) = record.payload, let screenshot = value.screenshotContextId {
                ids.insert(screenshot)
            }
        }
        let records = context.records.filter { ids.contains($0.contextId) }
        return records.isEmpty ? nil : OrchestrationMessageContext(records: records)
    }

    /// Attachment uploads replace client ids. Rebind payloads without changing link identity.
    public static func rebind(
        _ context: OrchestrationMessageContext?, attachmentIDs: [String: String]
    ) -> OrchestrationMessageContext? {
        guard var context else { return nil }
        context.records = context.records.map { record in
            var result = record
            guard var attachment = record.attachment,
                  let id = attachmentIDs[attachment.attachmentId] else { return result }
            attachment.attachmentId = id
            result.payload = record.kind == "image" ? .image(attachment) : .file(attachment)
            return result
        }
        return context
    }

    /// Older servers need readable text because they discard the context field.
    public static func providerProjection(_ text: String, context: OrchestrationMessageContext?) -> String {
        let references = collect(text)
        guard !references.isEmpty else { return text }
        let grouped = Dictionary(grouping: context?.records ?? [], by: \.contextId)
        let byID = grouped.compactMapValues { $0.count == 1 ? $0.first : nil }
        let body = replace(text) { reference in
            let kind = byID[reference.contextId]?.kind ?? reference.kind
            let spaced = kind.replacingOccurrences(of: "-", with: " ")
            let name = spaced.prefix(1).uppercased() + spaced.dropFirst()
            let label = reference.label.replacingOccurrences(of: #"[\r\n;\]]"#, with: " ", options: .regularExpression)
                .split(whereSeparator: \.isWhitespace).joined(separator: " ")
            return "[\(name): \(escapePayload(label)); ref=\(reference.contextId)]"
        }
        var seen = Set<String>()
        let entries = references.filter { seen.insert($0.contextId).inserted }.map { reference in
            let record = byID[reference.contextId]
            let open = "<context kind=\"\(record?.kind ?? reference.kind)\" id=\"\(reference.contextId)\""
            guard let record else { return open + " unavailable=\"true\"/>" }
            return open + ">\n" + escapePayload(providerPayload(record)) + "\n</context>"
        }
        return body + "\n\n<t3_context version=\"1\">\n" + entries.joined(separator: "\n") + "\n</t3_context>"
    }

    private static func escapePayload(_ text: String) -> String {
        text.replacingOccurrences(of: #"<(?=/?(?:t3_context|context)\b)"#, with: "&lt;", options: [.regularExpression, .caseInsensitive])
    }

    private static func indent(_ text: String) -> String {
        text.components(separatedBy: "\n").map { "  " + $0 }.joined(separator: "\n")
    }

    private static func elementLines(_ element: ComposerContextRecord.Element) -> [String] {
        var lines = ["url: \(element.pageUrl)", "tag: \(element.tagName)"]
        if let title = element.pageTitle, !title.isEmpty { lines.append("title: \(title)") }
        if let selector = element.selector, !selector.isEmpty { lines.append("selector: \(selector)") }
        if let component = element.componentName, !component.isEmpty { lines.append("component: \(component)") }
        if let source = element.source, let file = source.fileName, !file.isEmpty {
            var location = file
            if let line = source.lineNumber {
                location += ":\(line)"
                if let column = source.columnNumber { location += ":\(column)" }
            }
            lines.append("source: \(location)")
        }
        let html = element.htmlPreview.trimmingCharacters(in: .whitespacesAndNewlines)
        let styles = element.styles.trimmingCharacters(in: .whitespacesAndNewlines)
        if !html.isEmpty { lines += ["html:", indent(html)] }
        if !styles.isEmpty { lines += ["styles:", indent(styles)] }
        return lines
    }

    public static func providerPayload(_ record: ComposerContextRecord) -> String {
        switch record.payload {
        case let .image(value), let .file(value):
            return "name: \(value.name)\nmimeType: \(value.mimeType)\nsizeBytes: \(value.sizeBytes)\nattachmentId: \(value.attachmentId)"
        case let .terminal(value):
            let lines = value.text.components(separatedBy: "\n").prefix(min(value.lineEnd - value.lineStart, 64_000) + 1)
                .enumerated().map { "\(value.lineStart + $0.offset) | \($0.element)" }
            return (["terminal: \(value.terminalLabel)"] + lines).joined(separator: "\n")
        case let .mention(value): return "path: \(value.path)"
        case let .skill(value): return "name: \(value.name)"
        case let .reviewComment(value):
            var lines = ["file: \(value.filePath)", "range: \(value.rangeLabel) (\(value.startIndex)-\(value.endIndex))", "section: \(value.sectionTitle)"]
            let text = value.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { lines += ["comment:", indent(text)] }
            if !value.diff.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                lines += ["\(value.fenceLanguage ?? "diff"):", indent(value.diff.replacingOccurrences(of: #"\s+$"#, with: "", options: .regularExpression))]
            }
            return lines.joined(separator: "\n")
        case let .element(value): return elementLines(value).joined(separator: "\n")
        case let .previewAnnotation(value):
            let title = value.pageTitle?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            var lines = ["page: \(title.isEmpty ? value.pageUrl : title)", "url: \(value.pageUrl)"]
            let comment = value.comment.trimmingCharacters(in: .whitespacesAndNewlines)
            if !comment.isEmpty { lines.append("comment: \(comment)") }
            if !value.targetSummary.isEmpty { lines.append("targets: \(value.targetSummary)") }
            if !value.styleChanges.isEmpty { lines += ["requested visual changes:"] + value.styleChanges.map { "- " + $0 } }
            if let id = value.screenshotContextId { lines.append("screenshot: ref=\(id)") }
            for (index, element) in (value.elements ?? []).enumerated() {
                lines += ["element \(index + 1):", indent(elementLines(element).joined(separator: "\n"))]
            }
            return lines.joined(separator: "\n")
        case let .unknown(_, value):
            return (try? JSONEncoder.t3.encode(value)).map { String(decoding: $0, as: UTF8.self) } ?? "null"
        }
    }
}
