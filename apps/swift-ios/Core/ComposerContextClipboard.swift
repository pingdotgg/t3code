import Foundation

public struct ComposerContextClipboardFragment: Codable, Equatable, Sendable {
    public struct Source: Codable, Equatable, Sendable {
        public let environmentId: String
        public var threadId: String?
        public var messageId: String?

        public init(environmentId: String, threadId: String? = nil, messageId: String? = nil) {
            self.environmentId = environmentId
            self.threadId = threadId
            self.messageId = messageId
        }
    }

    public let version: Int
    public let source: Source
    public let records: [ComposerContextRecord]

    public init(source: Source, records: [ComposerContextRecord]) {
        version = 1
        self.source = source
        self.records = records
    }
}

public enum ComposerContextClipboardError: LocalizedError, Equatable {
    case invalidFragment
    case tooLarge
    case missingRecord
    case contextLimit
    case sourceUnavailable
    case draftChanged

    public var errorDescription: String? {
        switch self {
        case .invalidFragment: "The clipboard context is invalid. Copy it again from the source."
        case .tooLarge: "This context is too large to copy. Select fewer items."
        case .missingRecord: "A copied context item is missing its saved data. Copy it again from the source."
        case .contextLimit: "A message can have up to 200 context items. Remove some items and paste again."
        case .sourceUnavailable: "Reconnect to the source environment to paste its attachments."
        case .draftChanged: "The draft changed while the paste was loading. Paste again."
        }
    }
}

/// Matches the web/native clipboard contract. Binary data and resolved asset URLs stay out of this payload.
public enum ComposerContextClipboard {
    public static let mimeType = "web application/x-t3-context-fragment+json"
    public static let maximumCharacters = 16_000_000
    public static let maximumRecords = 200

    public struct Content: Equatable, Sendable {
        public let text: String
        public let fragment: ComposerContextClipboardFragment
    }

    public static func encode(_ fragment: ComposerContextClipboardFragment) throws -> String {
        try validate(fragment)
        let data = try JSONEncoder.t3.encode(fragment)
        let text = String(decoding: data, as: UTF8.self)
        guard text.utf16.count <= maximumCharacters else { throw ComposerContextClipboardError.tooLarge }
        return text
    }

    public static func decode(_ text: String) throws -> ComposerContextClipboardFragment {
        guard text.utf16.count <= maximumCharacters else { throw ComposerContextClipboardError.tooLarge }
        let fragment: ComposerContextClipboardFragment
        do {
            // Decode every record. An invalid record must not turn into a broken pasted link.
            fragment = try JSONDecoder.t3.decode(ComposerContextClipboardFragment.self, from: Data(text.utf8))
        } catch {
            throw ComposerContextClipboardError.invalidFragment
        }
        try validate(fragment)
        return fragment
    }

    private static func validate(_ fragment: ComposerContextClipboardFragment) throws {
        guard fragment.version == 1, !fragment.source.environmentId.isEmpty,
              Set(fragment.records.map(\.contextId)).count == fragment.records.count else {
            throw ComposerContextClipboardError.invalidFragment
        }
        guard fragment.records.count <= maximumRecords else { throw ComposerContextClipboardError.contextLimit }
    }

    public static func html(text: String, fragment: String) -> String {
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.~")
        let encoded = fragment.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
        let escaped = text.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
        return "<pre data-t3-context-fragment=\"\(encoded)\">\(escaped)</pre>"
    }

    public static func decodeHTML(_ html: String) throws -> ComposerContextClipboardFragment? {
        guard html.utf16.count <= maximumCharacters * 9 + 4_096 else {
            throw ComposerContextClipboardError.tooLarge
        }
        let expression = try NSRegularExpression(pattern: #"data-t3-context-fragment=["']([^"']+)["']"#)
        guard let match = expression.firstMatch(in: html, range: NSRange(location: 0, length: html.utf16.count)) else {
            return nil
        }
        guard let decoded = (html as NSString).substring(with: match.range(at: 1)).removingPercentEncoding else {
            throw ComposerContextClipboardError.invalidFragment
        }
        return try decode(decoded)
    }

    /// Include only selected records and the screenshots required by selected annotations.
    public static func selected(text: String, fragment: ComposerContextClipboardFragment) throws -> Content {
        try validate(fragment)
        let references = ComposerContextReferences.collect(text)
        let byID = Dictionary(uniqueKeysWithValues: fragment.records.map { ($0.contextId, $0) })
        var ids = Set<String>()
        for reference in references {
            guard let record = byID[reference.contextId], record.kind == reference.kind else {
                throw ComposerContextClipboardError.missingRecord
            }
            ids.insert(record.contextId)
            if case let .previewAnnotation(annotation) = record.payload, let screenshot = annotation.screenshotContextId {
                guard byID[screenshot]?.kind == "image" else { throw ComposerContextClipboardError.missingRecord }
                ids.insert(screenshot)
            }
        }
        return Content(text: text, fragment: .init(source: fragment.source, records: fragment.records.filter { ids.contains($0.contextId) }))
    }

    public static func reidentified(_ content: Content, createID: () -> String = { UUID().uuidString }) throws -> Content {
        let selected = try selected(text: content.text, fragment: content.fragment)
        let ids = Dictionary(uniqueKeysWithValues: selected.fragment.records.map { ($0.contextId, createID()) })
        guard Set(ids.values).count == ids.count else { throw ComposerContextClipboardError.invalidFragment }
        let text = ComposerContextReferences.replace(selected.text) { reference in
            let original = (selected.text as NSString).substring(with: reference.range)
            return original.replacingOccurrences(
                of: "t3-context://v1/\(reference.kind)/\(reference.contextId)",
                with: "t3-context://v1/\(reference.kind)/\(ids[reference.contextId]!)"
            )
        }
        let records = selected.fragment.records.map { record in
            var result = record
            result.contextId = ids[record.contextId]!
            if case var .previewAnnotation(annotation) = record.payload, let screenshot = annotation.screenshotContextId {
                annotation.screenshotContextId = ids[screenshot]!
                result.payload = .previewAnnotation(annotation)
            }
            return result
        }
        return Content(text: text, fragment: .init(source: selected.fragment.source, records: records))
    }
}
