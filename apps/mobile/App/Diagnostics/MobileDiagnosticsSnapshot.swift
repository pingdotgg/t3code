import Foundation

struct MobileDiagnosticsSnapshot: Equatable, Sendable {
    let connectionState: String
    let threadDetailState: String
    let environmentCount: Int
    let projectCount: Int
    let threadCount: Int
    let selectedThreadID: String?
    let shellSnapshotSequence: Int
    let selectedThreadSnapshotSequence: Int?
    let pendingResponseCount: Int
    let respondedRequestCount: Int
    let isSendingMessage: Bool
    let isInterrupting: Bool
    let recentEvents: [MobileDiagnosticsEntry]

    var exportText: String {
        var lines = [
            "T3 Code Mobile Diagnostics",
            "Connection: \(connectionState)",
            "Thread detail: \(threadDetailState)",
            "Environments: \(environmentCount)",
            "Projects: \(projectCount)",
            "Threads: \(threadCount)",
            "Selected thread: \(selectedThreadID ?? "none")",
            "Shell sequence: \(shellSnapshotSequence)",
            "Thread sequence: \(selectedThreadSnapshotSequence.map(String.init) ?? "none")",
            "Pending responses: \(pendingResponseCount)",
            "Responded requests: \(respondedRequestCount)",
            "Sending message: \(isSendingMessage)",
            "Interrupting: \(isInterrupting)",
            "",
            "Recent events:",
        ]
        lines.append(contentsOf: recentEvents.map { "\($0.createdAt) [\($0.level.rawValue)] \($0.message)" })
        return lines.joined(separator: "\n")
    }
}
