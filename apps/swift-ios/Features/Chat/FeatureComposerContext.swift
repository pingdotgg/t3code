import Foundation

enum FeatureComposerContext {
    enum MergeError: LocalizedError {
        case tooManyRecords
        var errorDescription: String? { "A message can include up to 200 context items. Remove an item before adding another." }
    }

    static func terminalRecord(text: String, terminalID: String, label: String) -> ComposerContextRecord {
        // Keep the newest output and its original line numbers within the wire limit.
        let suffix = String(decoding: text.utf16.suffix(64_000).drop(while: { (0xDC00...0xDFFF).contains($0) }), as: UTF16.self)
        let end = text.components(separatedBy: "\n").count - 1
        let start = max(0, end - suffix.components(separatedBy: "\n").count + 1)
        return ComposerContextRecord(label: "\(label) lines \(start)-\(end)", payload: .terminal(.init(
            terminalId: terminalID, terminalLabel: label, lineStart: start, lineEnd: end, text: suffix
        )))
    }

    static func merge(
        _ first: OrchestrationMessageContext?, _ second: OrchestrationMessageContext?
    ) throws -> OrchestrationMessageContext? {
        var seen = Set<String>()
        let records = ((first?.records ?? []) + (second?.records ?? [])).filter {
            seen.insert($0.contextId).inserted
        }
        guard records.count <= 200 else { throw MergeError.tooManyRecords }
        return records.isEmpty ? nil : OrchestrationMessageContext(records: records)
    }
}
