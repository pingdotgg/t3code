import Foundation

enum FeatureComposerContext {
    static func terminalRecord(text: String, terminalID: String, label: String) -> ComposerContextRecord {
        // Keep the newest output and its original line numbers within the wire limit.
        let suffix = String(decoding: text.utf16.suffix(64_000), as: UTF16.self)
        let end = text.components(separatedBy: "\n").count - 1
        let start = max(0, end - suffix.components(separatedBy: "\n").count + 1)
        return ComposerContextRecord(label: "\(label) lines \(start)-\(end)", payload: .terminal(.init(
            terminalId: terminalID, terminalLabel: label, lineStart: start, lineEnd: end, text: suffix
        )))
    }

    static func merge(
        _ first: OrchestrationMessageContext?, _ second: OrchestrationMessageContext?
    ) -> OrchestrationMessageContext? {
        var seen = Set<String>()
        let records = ((first?.records ?? []) + (second?.records ?? [])).filter {
            seen.insert($0.contextId).inserted
        }
        return records.isEmpty ? nil : OrchestrationMessageContext(records: records)
    }

    /// Keep linked records and annotation screenshots, including unknown kinds.
    static func referenced(_ context: OrchestrationMessageContext?, text: String) -> OrchestrationMessageContext? {
        guard let context else { return nil }
        var ids = Set(ComposerContextReferences.collect(text).map(\.contextId))
        for record in context.records where ids.contains(record.contextId) {
            if case let .previewAnnotation(value) = record.payload, let screenshot = value.screenshotContextId {
                ids.insert(screenshot)
            }
        }
        let records = context.records.filter { ids.contains($0.contextId) }
        return records.isEmpty ? nil : OrchestrationMessageContext(records: records)
    }
}
