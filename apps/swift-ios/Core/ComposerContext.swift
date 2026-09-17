import Foundation

/// The link owns position. A record owns the captured data behind that link.
public struct ComposerContextRecord: Codable, Equatable, Hashable, Sendable, Identifiable {
    public var id: String { contextId }
    public let version: Int
    public var contextId: String
    public let label: String
    public var payload: Payload

    public enum Payload: Equatable, Hashable, Sendable {
        case image(Attachment)
        case file(Attachment)
        case terminal(Terminal)
        case element(Element)
        case previewAnnotation(PreviewAnnotation)
        case reviewComment(ReviewComment)
        case mention(Mention)
        case skill(Skill)
        case unknown(kind: String, payload: JSONValue)
    }

    public struct Attachment: Codable, Equatable, Hashable, Sendable {
        public var attachmentId: String
        public let name: String
        public let mimeType: String
        public let sizeBytes: Int
    }

    public struct Terminal: Codable, Equatable, Hashable, Sendable {
        public let terminalId: String
        public let terminalLabel: String
        public let lineStart: Int
        public let lineEnd: Int
        public let text: String
    }

    public struct Element: Codable, Equatable, Hashable, Sendable {
        public struct Source: Codable, Equatable, Hashable, Sendable {
            public let functionName: String?
            public let fileName: String?
            public let lineNumber: Int?
            public let columnNumber: Int?

            private enum CodingKeys: String, CodingKey { case functionName, fileName, lineNumber, columnNumber }
            public func encode(to encoder: any Encoder) throws {
                var values = encoder.container(keyedBy: CodingKeys.self)
                try values.encode(functionName, forKey: .functionName)
                try values.encode(fileName, forKey: .fileName)
                try values.encode(lineNumber, forKey: .lineNumber)
                try values.encode(columnNumber, forKey: .columnNumber)
            }
        }
        public let pageUrl: String
        public let pageTitle: String?
        public let tagName: String
        public let selector: String?
        public let htmlPreview: String
        public let componentName: String?
        public let source: Source?
        public let styles: String

        private enum CodingKeys: String, CodingKey { case pageUrl, pageTitle, tagName, selector, htmlPreview, componentName, source, styles }
        public func encode(to encoder: any Encoder) throws {
            var values = encoder.container(keyedBy: CodingKeys.self)
            try values.encode(pageUrl, forKey: .pageUrl)
            try values.encode(pageTitle, forKey: .pageTitle)
            try values.encode(tagName, forKey: .tagName)
            try values.encode(selector, forKey: .selector)
            try values.encode(htmlPreview, forKey: .htmlPreview)
            try values.encode(componentName, forKey: .componentName)
            try values.encode(source, forKey: .source)
            try values.encode(styles, forKey: .styles)
        }
    }

    public struct PreviewAnnotation: Codable, Equatable, Hashable, Sendable {
        public struct StyleChange: Codable, Equatable, Hashable, Sendable {
            public let targetId: String
            public let selector: String?
            public let property: String
            public let previousValue: String
            public let value: String

            private enum CodingKeys: String, CodingKey { case targetId, selector, property, previousValue, value }
            public func encode(to encoder: any Encoder) throws {
                var values = encoder.container(keyedBy: CodingKeys.self)
                try values.encode(targetId, forKey: .targetId)
                try values.encode(selector, forKey: .selector)
                try values.encode(property, forKey: .property)
                try values.encode(previousValue, forKey: .previousValue)
                try values.encode(value, forKey: .value)
            }
        }
        public let annotationId: String
        public let pageUrl: String
        public let pageTitle: String?
        public let comment: String
        public let targetSummary: String
        public let styleChanges: [String]
        public let elements: [Element]?
        public let elementIds: [String]?
        public let regionCount: Int?
        public let strokeCount: Int?
        public let styleChangeDetails: [StyleChange]?
        public var screenshotContextId: String?

        private enum CodingKeys: String, CodingKey {
            case annotationId, pageUrl, pageTitle, comment, targetSummary, styleChanges
            case elements, elementIds, regionCount, strokeCount, styleChangeDetails, screenshotContextId
        }
        public func encode(to encoder: any Encoder) throws {
            var values = encoder.container(keyedBy: CodingKeys.self)
            try values.encode(annotationId, forKey: .annotationId)
            try values.encode(pageUrl, forKey: .pageUrl)
            try values.encode(pageTitle, forKey: .pageTitle)
            try values.encode(comment, forKey: .comment)
            try values.encode(targetSummary, forKey: .targetSummary)
            try values.encode(styleChanges, forKey: .styleChanges)
            try values.encodeIfPresent(elements, forKey: .elements)
            try values.encodeIfPresent(elementIds, forKey: .elementIds)
            try values.encodeIfPresent(regionCount, forKey: .regionCount)
            try values.encodeIfPresent(strokeCount, forKey: .strokeCount)
            try values.encodeIfPresent(styleChangeDetails, forKey: .styleChangeDetails)
            try values.encodeIfPresent(screenshotContextId, forKey: .screenshotContextId)
        }
    }

    public struct ReviewComment: Codable, Equatable, Hashable, Sendable {
        public struct PullRequest: Codable, Equatable, Hashable, Sendable {
            public let number: Int
            public let title: String
            public let url: String
            public let headBranch: String
            public let baseBranch: String
            public let state: String
            public let isDraft: Bool
        }
        public let sectionId: String
        public let sectionTitle: String
        public let filePath: String
        public let startIndex: Int
        public let endIndex: Int
        public let rangeLabel: String
        public let text: String
        public let diff: String
        public let fenceLanguage: String?
        public let pullRequest: PullRequest?
    }

    public struct Mention: Codable, Equatable, Hashable, Sendable {
        public let path: String
    }

    public struct Skill: Codable, Equatable, Hashable, Sendable {
        public let name: String
    }

    public var kind: String {
        switch payload {
        case .image: "image"
        case .file: "file"
        case .terminal: "terminal"
        case .element: "element"
        case .previewAnnotation: "preview-annotation"
        case .reviewComment: "review-comment"
        case .mention: "mention"
        case .skill: "skill"
        case let .unknown(kind, _): kind
        }
    }

    public init(contextId: String = UUID().uuidString, label: String, payload: Payload) {
        version = 1
        self.contextId = contextId
        self.label = ComposerContextReferences.sanitizeLabel(label, kind: "context")
        self.payload = payload
    }

    private enum CodingKeys: String, CodingKey {
        case version, contextId, label, kind, payload
    }

    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        version = try values.decode(Int.self, forKey: .version)
        contextId = try values.decode(String.self, forKey: .contextId)
        label = try values.decode(String.self, forKey: .label)
        let kind = try values.decode(String.self, forKey: .kind)
        guard version == 1, label.utf16.count <= 200,
              ComposerContextReferences.parseHref("t3-context://v1/\(kind)/\(contextId)") != nil else {
            throw DecodingError.dataCorruptedError(forKey: .kind, in: values, debugDescription: "Invalid context identity")
        }
        switch kind {
        case "image": payload = .image(try Attachment(from: decoder))
        case "file": payload = .file(try Attachment(from: decoder))
        case "terminal":
            let value = try Terminal(from: decoder)
            guard value.lineStart >= 0, value.lineEnd >= value.lineStart, value.text.utf16.count <= 64_000 else {
                throw DecodingError.dataCorruptedError(forKey: .kind, in: values, debugDescription: "Invalid terminal context")
            }
            payload = .terminal(value)
        case "element": payload = .element(try Element(from: decoder))
        case "preview-annotation": payload = .previewAnnotation(try PreviewAnnotation(from: decoder))
        case "review-comment":
            let value = try ReviewComment(from: decoder)
            guard value.startIndex >= 0, value.endIndex >= value.startIndex,
                  value.text.utf16.count <= 16_000, value.diff.utf16.count <= 32_000 else {
                throw DecodingError.dataCorruptedError(forKey: .kind, in: values, debugDescription: "Invalid review context")
            }
            payload = .reviewComment(value)
        case "mention": payload = .mention(try Mention(from: decoder))
        case "skill": payload = .skill(try Skill(from: decoder))
        default: payload = .unknown(kind: kind, payload: try values.decode(JSONValue.self, forKey: .payload))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(version, forKey: .version)
        try values.encode(contextId, forKey: .contextId)
        try values.encode(label, forKey: .label)
        try values.encode(kind, forKey: .kind)
        switch payload {
        case let .image(value), let .file(value): try value.encode(to: encoder)
        case let .terminal(value): try value.encode(to: encoder)
        case let .element(value): try value.encode(to: encoder)
        case let .previewAnnotation(value): try value.encode(to: encoder)
        case let .reviewComment(value): try value.encode(to: encoder)
        case let .mention(value): try value.encode(to: encoder)
        case let .skill(value): try value.encode(to: encoder)
        case let .unknown(_, value): try values.encode(value, forKey: .payload)
        }
    }

    public var attachment: Attachment? {
        switch payload {
        case let .file(value), let .image(value): value
        default: nil
        }
    }
}

public struct OrchestrationMessageContext: Codable, Equatable, Hashable, Sendable {
    public let version: Int
    public var records: [ComposerContextRecord]

    public init(records: [ComposerContextRecord]) {
        version = 1
        self.records = records
    }

    private enum CodingKeys: String, CodingKey { case version, records }

    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        version = try values.decode(Int.self, forKey: .version)
        let raw = try values.decode([JSONValue].self, forKey: .records)
        guard version == 1, raw.count <= 200 else {
            throw DecodingError.dataCorruptedError(forKey: .records, in: values, debugDescription: "Invalid message context")
        }
        records = raw.compactMap { try? $0.decode(ComposerContextRecord.self) }
        guard Set(records.map(\.contextId)).count == records.count else {
            throw DecodingError.dataCorruptedError(forKey: .records, in: values, debugDescription: "Duplicate context identity")
        }
    }
}

public enum PastedTextAttachmentSource: String, Codable, Equatable, Hashable, Sendable {
    case pastedText = "pasted-text"

    private enum CodingKeys: String, CodingKey { case tag = "_tag" }

    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let tag = try values.decode(String.self, forKey: .tag)
        guard let source = Self(rawValue: tag) else {
            throw DecodingError.dataCorruptedError(forKey: .tag, in: values, debugDescription: "Unknown file source")
        }
        self = source
    }

    public func encode(to encoder: any Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(rawValue, forKey: .tag)
    }
}
