import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Indexed timeline upserts")
struct TimelineUpsertIndexTests {
    private enum ItemSignature: Equatable {
        case user(id: String, text: String, at: TimeInterval)
        case reasoning(id: String, text: String, at: TimeInterval)
        case tool(
            id: String, name: String, detail: String, kind: String, status: String,
            at: TimeInterval, output: String?, outputIsError: Bool)
        case other(id: String, description: String)
    }

    private func date(_ seconds: TimeInterval) -> Date {
        Date(timeIntervalSince1970: seconds)
    }

    private func signature(_ item: TimelineItem) -> ItemSignature {
        switch item {
        case .userMessage(let id, let text, let at):
            .user(id: id, text: text, at: at.timeIntervalSince1970)
        case .reasoning(let id, let text, let at):
            .reasoning(id: id, text: text, at: at.timeIntervalSince1970)
        case .toolEvent(
            let id, let name, let detail, let kind, let status, let at, let output, let outputIsError):
            .tool(
                id: id, name: name, detail: detail, kind: kind.rawValue, status: status.rawValue,
                at: at.timeIntervalSince1970, output: output, outputIsError: outputIsError)
        default:
            .other(id: item.id, description: String(describing: item))
        }
    }

    private func signatures(_ items: [TimelineItem]) -> [ItemSignature] {
        items.map(signature)
    }

    private func assertIndexMatchesArray(
        _ items: [TimelineItem], indexByID: [String: Int], sourceLocation: SourceLocation = #_sourceLocation
    ) {
        for (index, item) in items.enumerated() {
            #expect(indexByID[item.id] == index, sourceLocation: sourceLocation)
        }
    }

    @Test("indexed and non-indexed upserts stay behaviorally identical")
    func differentialScript() {
        let script: [TimelineItem] = [
            .userMessage(id: "user-1", text: "first", at: date(1)),
            .toolEvent(
                id: "tool:1", name: "Bash", detail: "pwd", kind: .command, status: .running,
                at: date(2), output: nil, outputIsError: false),
            .reasoning(id: "reason-1", text: "checking", at: date(3)),
            // An uncorrelated completion folds into the running row despite
            // the interleaved reasoning item.
            .toolEvent(
                id: "event:1", name: "Bash", detail: "pwd", kind: .other, status: .succeeded,
                at: date(4), output: "directory", outputIsError: false),
            // Same-id lifecycle replacement exercises the indexed hit path.
            .toolEvent(
                id: "event:1", name: "Bash", detail: "", kind: .other, status: .failed,
                at: date(5), output: nil, outputIsError: true),
            .toolEvent(
                id: "tool:2", name: "Bash", detail: "git status", kind: .command,
                status: .running, at: date(6), output: nil, outputIsError: false),
            .reasoning(id: "reason-2", text: "waiting", at: date(7)),
            .toolEvent(
                id: "completion:2", name: "Bash", detail: "git status", kind: .command,
                status: .succeeded, at: date(8), output: "clean", outputIsError: false),
            .userMessage(id: "user-2", text: "second", at: date(9)),
            .toolEvent(
                id: "tool:3", name: "Bash", detail: "git log", kind: .command, status: .running,
                at: date(10), output: nil, outputIsError: false),
            .toolEvent(
                id: "event:3", name: "Bash", detail: "git log", kind: .command,
                status: .succeeded, at: date(11), output: "commits", outputIsError: false),
        ]

        var reference: [TimelineItem] = []
        var indexed: [TimelineItem] = []
        var indexByID: [String: Int] = [:]

        for (step, item) in script.enumerated() {
            reference.upsertTimelineItem(item)
            indexed.upsertTimelineItem(item, indexByID: &indexByID)

            #expect(
                signatures(indexed) == signatures(reference),
                "arrays differ after scripted step \(step)")
            assertIndexMatchesArray(indexed, indexByID: indexByID)
        }

        #expect(!indexByID.keys.contains("tool:1"))
        #expect(!indexByID.keys.contains("tool:2"))
        #expect(!indexByID.keys.contains("tool:3"))
    }

    @Test("a stale index slot self-repairs before replacing an id hit")
    func staleIndexRepairs() {
        let user = TimelineItem.userMessage(id: "user-1", text: "first", at: date(1))
        let running = TimelineItem.toolEvent(
            id: "tool:1", name: "Bash", detail: "pwd", kind: .command, status: .running,
            at: date(2), output: nil, outputIsError: false)
        let completed = TimelineItem.toolEvent(
            id: "tool:1", name: "Bash", detail: "pwd", kind: .command, status: .succeeded,
            at: date(3), output: "directory", outputIsError: false)

        var reference = [user, running]
        var indexed = reference
        var indexByID = ["user-1": 0, "tool:1": 999]

        reference.upsertTimelineItem(completed)
        indexed.upsertTimelineItem(completed, indexByID: &indexByID)
        #expect(signatures(indexed) == signatures(reference))
        #expect(indexByID["tool:1"] == 1)

        // A valid but mismatched slot must also fall back to the scan.
        indexByID["tool:1"] = 0
        let completedAgain = TimelineItem.toolEvent(
            id: "tool:1", name: "Bash", detail: "pwd", kind: .command, status: .failed,
            at: date(4), output: "failed", outputIsError: true)
        reference.upsertTimelineItem(completedAgain)
        indexed.upsertTimelineItem(completedAgain, indexByID: &indexByID)
        #expect(signatures(indexed) == signatures(reference))
        #expect(indexByID["tool:1"] == 1)
    }
}
