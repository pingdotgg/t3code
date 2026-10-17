import Foundation
import UIKit
import UniformTypeIdentifiers

@MainActor
enum FeatureContextClipboard {
    private static var retainedEnvironmentID: String?
    private static var retainedAttachments: [FeatureDraftAttachment] = []

    /// Keep local bytes in the app, not on the system clipboard. This also keeps cut attachments available.
    static func write(
        text: String,
        source: ComposerContextClipboardFragment.Source?,
        context: OrchestrationMessageContext?,
        attachments: [FeatureDraftAttachment] = [],
        pasteboard: UIPasteboard = .general
    ) throws -> Bool {
        guard !ComposerContextReferences.collect(text).isEmpty else { return false }
        guard let source else { return false }
        let content = try ComposerContextClipboard.selected(
            text: text, fragment: .init(source: source, records: context?.records ?? [])
        )
        let encoded = try ComposerContextClipboard.encode(content.fragment)
        let ids = Set(content.fragment.records.compactMap { $0.attachment?.attachmentId.lowercased() })
        retainedEnvironmentID = source.environmentId
        retainedAttachments = attachments.filter {
            ids.contains($0.id.uuidString.lowercased())
                || ($0.uploadedReference?.environmentID == source.environmentId
                    && ids.contains($0.uploadedReference?.attachmentID.lowercased() ?? ""))
        }
        pasteboard.items = [[
            UTType.utf8PlainText.identifier: text,
            ComposerContextClipboard.mimeType: Data(encoded.utf8),
            UTType.html.identifier: Data(ComposerContextClipboard.html(text: text, fragment: encoded).utf8),
        ]]
        return true
    }

    static func read(from pasteboard: UIPasteboard = .general) throws -> ComposerContextClipboard.Content? {
        func string(for type: String) -> String? {
            if let data = pasteboard.data(forPasteboardType: type) { return String(data: data, encoding: .utf8) }
            return pasteboard.value(forPasteboardType: type) as? String
        }
        var fragment: ComposerContextClipboardFragment?
        var decodingError: (any Error)?
        if let raw = string(for: ComposerContextClipboard.mimeType) {
            do { fragment = try ComposerContextClipboard.decode(raw) }
            catch { decodingError = error }
        }
        if fragment == nil, let html = string(for: UTType.html.identifier) {
            do { fragment = try ComposerContextClipboard.decodeHTML(html) }
            catch { decodingError = error }
        }
        guard let fragment else {
            if let decodingError { throw decodingError }
            return nil
        }
        guard let text = pasteboard.string else { throw ComposerContextClipboardError.invalidFragment }
        let content = try ComposerContextClipboard.selected(text: text, fragment: fragment)
        return content.fragment.records.isEmpty ? nil : content
    }

    static func retainedAttachment(environmentID: String, attachmentID: String) -> FeatureDraftAttachment? {
        guard retainedEnvironmentID == environmentID else { return nil }
        return retainedAttachments.first {
            $0.id.uuidString.caseInsensitiveCompare(attachmentID) == .orderedSame
                || ($0.uploadedReference?.environmentID == environmentID
                    && $0.uploadedReference?.attachmentID == attachmentID)
        }
    }

    /// UIKit history renders links as labels. Rebuild only the selected link spans without changing the selection.
    static func selectionText(_ selected: NSAttributedString, originalSource: String) -> String {
        let result = NSMutableString()
        let references = ComposerContextReferences.collect(originalSource)
        selected.enumerateAttribute(.link, in: NSRange(location: 0, length: selected.length)) { value, range, _ in
            let part = selected.attributedSubstring(from: range)
            let text = FeatureInlineSkillProjection.plainText(from: part)
            let href = (value as? URL)?.absoluteString ?? value as? String
            guard let href, let identity = ComposerContextReferences.parseHref(href) else {
                result.append(text)
                return
            }
            if let original = references.first(where: {
                $0.contextId == identity.contextId && $0.kind == identity.kind && $0.label == text
            }) {
                result.append((originalSource as NSString).substring(with: original.range))
            } else {
                result.append("[\(ComposerContextReferences.sanitizeLabel(text, kind: identity.kind))](\(href))")
            }
        }
        return result as String
    }
}
