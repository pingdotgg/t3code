import Foundation

/// Dominant signal of one conversation turn, for the run tape. Dominance is
/// `fail` > `edit` > `work` > `talk`: trouble outranks landed work, landed
/// work outranks reads, reads outrank pure conversation.
///
/// The tape reports tempo and trouble, never merit — the timeline model
/// carries no exit codes or test results, so nothing here claims "tests
/// passed"; the strongest positive statement a cell can make is "files were
/// edited and no tool failed".
enum RunSignal: String, Sendable {
    /// At least one tool call in the turn failed.
    case fail
    /// At least one file was changed and nothing failed.
    case edit
    /// Tools ran (reads, searches, commands) but nothing was edited.
    case work
    /// Conversation only — no tool calls.
    case talk
}

/// One turn of a thread, compressed to the tape's per-cell facts.
struct RunTapeCell: Identifiable, Equatable, Sendable {
    /// Row id of the user message that opened the turn — the same id the
    /// timeline rows carry, so a cell can drive scroll-to-turn. A leading
    /// turn with no user message gets a derived placeholder id.
    let id: String
    /// 1-based position in the tape.
    let turnNumber: Int
    let signal: RunSignal
    let toolCount: Int
    let failedCount: Int
    /// Distinct `.fileChange` details, deduped on the raw detail string —
    /// the same approximation `TurnActivity.filesTouched` uses.
    let editedFileCount: Int
    /// Any tool in the turn still reports `.running`. The view decides what
    /// that means (a settled thread's dangling running row is not live).
    let hasRunningTool: Bool

    var summaryLine: String {
        guard toolCount > 0 else { return "no tools" }
        var parts = ["\(toolCount) tool\(toolCount == 1 ? "" : "s")"]
        if editedFileCount > 0 {
            parts.append("\(editedFileCount) file\(editedFileCount == 1 ? "" : "s")")
        }
        if failedCount > 0 {
            parts.append("\(failedCount) failed")
        }
        return parts.joined(separator: " · ")
    }
}

/// Pure fold from a timeline to its run tape. Turn segmentation mirrors
/// `TurnActivityProjection`: a user message opens a new turn; everything
/// after it belongs to that turn until the next user message. Items before
/// the first user message form a leading turn only when they contain any
/// tool or assistant activity.
enum RunTapeProjection {
    static func tape(timeline: [TimelineItem]) -> [RunTapeCell] {
        var cells: [RunTapeCell] = []
        var openID: String?
        var toolCount = 0
        var failedCount = 0
        var runningCount = 0
        var editedDetails: Set<String> = []
        var leadingHasContent = false

        func close() {
            let isLeading = openID == nil
            if isLeading && !leadingHasContent { return }
            let number = cells.count + 1
            cells.append(
                RunTapeCell(
                    id: openID ?? "runtape-leading-turn",
                    turnNumber: number,
                    signal: signal(
                        toolCount: toolCount, failedCount: failedCount,
                        editedFileCount: editedDetails.count),
                    toolCount: toolCount,
                    failedCount: failedCount,
                    editedFileCount: editedDetails.count,
                    hasRunningTool: runningCount > 0))
        }

        for item in timeline {
            switch item {
            case .userMessage(let id, _, _, _):
                close()
                openID = id
                toolCount = 0
                failedCount = 0
                runningCount = 0
                editedDetails = []
            case .toolEvent(_, _, let detail, let kind, let status, _, _, _):
                leadingHasContent = true
                toolCount += 1
                if status == .failed { failedCount += 1 }
                if status == .running { runningCount += 1 }
                if kind == .fileChange, !detail.isEmpty { editedDetails.insert(detail) }
            case .assistantMessage, .reasoning, .subagentTask:
                leadingHasContent = true
            default:
                break
            }
        }
        close()
        return cells
    }

    private static func signal(
        toolCount: Int, failedCount: Int, editedFileCount: Int
    ) -> RunSignal {
        if failedCount > 0 { return .fail }
        if editedFileCount > 0 { return .edit }
        if toolCount > 0 { return .work }
        return .talk
    }
}

/// Memo over `RunTapeProjection`, one entry per thread, keyed on
/// `structureVersion` — the tape only changes on structural timeline edits
/// (new rows, running-ness flips), never on streaming content refreshes.
/// Same known limitation as the display cache: a succeeded→failed flip that
/// never passed through `.running` is non-structural and shows up on the
/// next structural bump.
///
/// Process-wide static like `TimelineDisplayCache`; tests reset it and run
/// `--no-parallel`.
@MainActor
enum RunTapeCache {
    private struct Entry {
        var structureVersion: Int
        var cells: [RunTapeCell]
    }

    private static var storage: [String: Entry] = [:]

    static func tape(
        timeline: [TimelineItem], threadID: String, structureVersion: Int
    ) -> [RunTapeCell] {
        if let entry = storage[threadID], entry.structureVersion == structureVersion {
            return entry.cells
        }
        let cells = RunTapeProjection.tape(timeline: timeline)
        storage[threadID] = Entry(structureVersion: structureVersion, cells: cells)
        return cells
    }

    /// Drop a thread's memo entry (timeline release / eviction / removal).
    static func evict(threadID: String) {
        storage.removeValue(forKey: threadID)
    }

    static func resetForTesting() {
        storage.removeAll(keepingCapacity: true)
    }
}
