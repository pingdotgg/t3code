import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Background command presentation")
@MainActor
struct BackgroundCommandPresentationTests {
    private let now = Date(timeIntervalSince1970: 1_000)

    @Test("title falls back to a command label, never a sub-agent one")
    func titleFallsBackToCommandLabel() {
        var task = backgroundCommand()
        #expect(BackgroundCommandPresentation.title(for: task) == "Run full mac test suite")

        task.description = "   "
        #expect(BackgroundCommandPresentation.title(for: task) == "Background command")
    }

    @Test("streamed chunks concatenate into the process output")
    func outputJoinsProgressChunks() throws {
        let task = backgroundCommand(progress: ["Building for debugging...", "Test Suite started"])

        let output = try #require(BackgroundCommandPresentation.output(for: task))
        #expect(output == "Building for debugging...\nTest Suite started")
    }

    @Test("a task with no streamed output has no output block")
    func noOutputWithoutProgress() {
        #expect(BackgroundCommandPresentation.output(for: backgroundCommand()) == nil)
    }

    @Test("output keeps the tail and reports the dropped line count")
    func outputTailKeepsTheEnd() {
        let text = (1...10).map { "line \($0)" }.joined(separator: "\n")

        let tail = BackgroundCommandPresentation.outputTail(text, limit: 3)

        #expect(tail.text == "line 8\nline 9\nline 10")
        #expect(tail.hiddenLines == 7)
        #expect(BackgroundCommandPresentation.outputTail(text, limit: 20).hiddenLines == 0)
    }

    @Test("status line reads as shell work, not agent chatter")
    func statusLineReadsAsShellWork() {
        var task = backgroundCommand()
        task.lastActivityAt = now.addingTimeInterval(-30)
        #expect(
            BackgroundCommandPresentation.statusLine(for: task, at: now)
                == "Running in background · last activity 30s ago")

        task.state = .completed
        #expect(BackgroundCommandPresentation.statusLine(for: task, at: now) == "Finished")

        task.state = .failed
        task.error = "exited with code 1"
        #expect(
            BackgroundCommandPresentation.statusLine(for: task, at: now) == "exited with code 1")
    }

    private func backgroundCommand(progress: [String] = []) -> SubagentTaskItem {
        SubagentTaskItem(
            taskId: "cmd-1",
            taskType: "local_bash",
            entityKind: .command,
            description: "Run full mac test suite",
            state: .running,
            latestProgress: nil,
            lastToolName: "local_bash",
            isBackgrounded: true,
            startedAt: now.addingTimeInterval(-240),
            lastActivityAt: now,
            duration: nil,
            progressLog: progress.enumerated().map { index, text in
                SubagentTaskProgressEntry(
                    at: now.addingTimeInterval(TimeInterval(-120 + index)),
                    toolName: "local_bash", text: text)
            })
    }
}
