import CryptoKit
import Foundation

/// Checkpoint choices come from the selected protocol's thread snapshot, never
/// from transcript positions or a count of rendered assistant messages.
enum NativeReviewSources {
    static func checkpoints(_ thread: OrchestrationThread) -> [FeatureReviewSource] {
        let checkpoints: [(id: String, count: Int)]
        if let projection = thread.orchestrationV2Control {
            let completedRuns = Set(values(projection["runs"]).filter { $0["status"]?.stringValue == "completed" }.compactMap { $0["id"]?.stringValue })
            checkpoints = values(projection["checkpoints"]).compactMap { checkpoint in
                guard checkpoint["status"]?.stringValue == "ready",
                      let runID = checkpoint["runId"]?.stringValue,
                      completedRuns.contains(runID),
                      let count = checkpoint["appRunOrdinal"]?.v2Int, count > 0,
                      let id = checkpoint["id"]?.stringValue,
                      let scope = checkpoint["scopeId"]?.stringValue else { return nil }
                return ("checkpoint:\(scope):\(id)", count)
            }
        } else {
            checkpoints = thread.checkpoints.compactMap { checkpoint in
                guard checkpoint.status == "ready", checkpoint.checkpointTurnCount > 0 else { return nil }
                return ("turn:\(checkpoint.turnId):\(checkpoint.checkpointRef)", checkpoint.checkpointTurnCount)
            }
        }
        let sorted = checkpoints.sorted { $0.count > $1.count }
        var result = sorted.enumerated().map { index, checkpoint in
            FeatureReviewSource(
                id: checkpoint.id,
                title: index == 0 ? "Latest turn (\(checkpoint.count))" : "Turn \(checkpoint.count)",
                target: .turn(checkpointID: checkpoint.id, fromTurnCount: max(0, checkpoint.count - 1), toTurnCount: checkpoint.count)
            )
        }
        if let latest = sorted.first {
            result.append(FeatureReviewSource(id: "full-thread", title: "All turns", target: .fullThread(toTurnCount: latest.count)))
        }
        return result
    }

    static func diffSource(_ diff: ReviewCheckpointDiff, id: String, title: String) -> ReviewDiffSource {
        ReviewDiffSource(id: id, kind: "checkpoint", title: title, baseRef: nil, headRef: nil,
            diff: diff.diff, diffHash: Data(SHA256.hash(data: Data(diff.diff.utf8))).base64EncodedString(), truncated: false)
    }

    private static func values(_ value: JSONValue?) -> [JSONValue] {
        guard case let .array(values) = value else { return [] }
        return values
    }
}
