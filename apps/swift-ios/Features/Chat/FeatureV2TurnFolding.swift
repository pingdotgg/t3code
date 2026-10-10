import Foundation

/// Optional display folds. The authoritative message array stays unchanged;
/// opening a fold restores each row in its original position.
enum FeatureV2TurnFolding {
    private struct RunKey: Hashable {
        let threadID: String
        let runID: String
        let visibility: String
    }

    static func messages(_ messages: [FeatureMessage], expandedIDs: Set<String>) -> [FeatureMessage] {
        var firstAssistant: [RunKey: String] = [:]
        var lastAssistant: [RunKey: String] = [:]
        var blockedRuns: Set<RunKey> = []
        for message in messages {
            guard let key = runKey(message) else { continue }
            if message.state == .streaming || message.v2Timeline?.runStatus != "completed"
                || message.v2Timeline?.itemType == "run_interrupt_result"
                || message.v2WorkItems?.contains(where: { $0.indicatesFailure || $0.source.itemType == "run_interrupt_result" }) == true {
                blockedRuns.insert(key)
            }
            if message.role == .assistant {
                firstAssistant[key] = firstAssistant[key] ?? message.id
                lastAssistant[key] = message.id
            }
        }
        var result: [FeatureMessage] = []
        var pending: [FeatureMessage] = []
        var pendingKey: RunKey?
        func flush() {
            guard let first = pending.first else { return }
            // A fold should contain work, not just shorten an assistant reply.
            if pending.contains(where: { $0.v2WorkItems?.contains { $0.source.itemType != "compaction" } == true }) {
                let id = "v2-fold:\(first.id)"
                var fold = FeatureMessage(id: id, role: .system, text: label(first.v2Timeline), createdAt: first.createdAt)
                fold.v2Timeline = first.v2Timeline
                fold.v2FoldID = id
                result.append(fold)
                if expandedIDs.contains(id) { result.append(contentsOf: pending) }
            } else { result.append(contentsOf: pending) }
            pending.removeAll(keepingCapacity: true)
            pendingKey = nil
        }
        for message in messages {
            let key = runKey(message)
            let plainWork = message.role == .tool && message.v2WorkItems?.allSatisfy {
                !$0.isStandaloneContent && ["reasoning", "command_execution", "dynamic_tool", "file_change", "file_search", "web_search", "compaction"].contains($0.source.itemType)
            } == true
            let intermediateAssistant = message.role == .assistant && key.map {
                firstAssistant[$0] != message.id && lastAssistant[$0] != message.id
            } == true
            if let key, !blockedRuns.contains(key), plainWork || intermediateAssistant {
                if pendingKey != nil, pendingKey != key { flush() }
                pendingKey = key
                pending.append(message)
            } else {
                flush()
                result.append(message)
            }
        }
        flush()
        return result
    }

    private static func runKey(_ message: FeatureMessage) -> RunKey? {
        guard let source = message.v2Timeline, let runID = source.runID else { return nil }
        return RunKey(threadID: source.sourceThreadID, runID: runID, visibility: source.visibility)
    }

    private static func label(_ source: OrchestrationV2TimelineMetadata?) -> String {
        guard let start = (source?.runStartedAt).flatMap(parseDate),
              let end = (source?.runCompletedAt).flatMap(parseDate), end >= start else { return "Worked" }
        let seconds = Int(end.timeIntervalSince(start))
        return seconds < 60 ? "Worked for \(seconds)s" : "Worked for \(seconds / 60)m \(seconds % 60)s"
    }

    private static func parseDate(_ value: String) -> Date? {
        (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(value))
            ?? (try? Date.ISO8601FormatStyle().parse(value))
    }
}
