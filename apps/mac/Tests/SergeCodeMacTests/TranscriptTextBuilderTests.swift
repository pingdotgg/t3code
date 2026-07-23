import AppKit
import Foundation
import Testing
import T3Kit

@testable import SergeCodeMac

@Suite("Transcript text builder")
@MainActor
struct TranscriptTextBuilderTests {

    @Test("orders role headers, prose, code, and tool output")
    func orderingHeadersProseCodeTool() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let items: [TimelineDisplayItem] = [
            .single(
                .userMessage(id: "u1", text: "Please fix the sort.", attachments: [], at: now)),
            .single(
                .assistantMessage(
                    id: "a1",
                    markdown: """
                        Here is the plan.

                        ```swift
                        threads.sort { $0.updatedAt > $1.updatedAt }
                        ```

                        That should pin the order.
                        """,
                    isStreaming: false,
                    at: now)),
            .single(
                .toolEvent(
                    id: "t1", name: "run_command", detail: "Bash: git status",
                    kind: .command, status: .succeeded, at: now,
                    output: "On branch main\nnothing to commit", outputIsError: false)),
        ]

        let attributed = TranscriptTextBuilder.attributedString(from: items)
        let plain = attributed.string

        #expect(plain.contains("You"))
        #expect(plain.contains("Please fix the sort."))
        #expect(plain.contains("Assistant"))
        #expect(plain.contains("Here is the plan."))
        #expect(plain.contains("threads.sort { $0.updatedAt > $1.updatedAt }"))
        #expect(plain.contains("That should pin the order."))
        #expect(plain.contains("Tool · run_command"))
        #expect(plain.contains("git status"))
        #expect(plain.contains("On branch main"))
        #expect(plain.contains("nothing to commit"))

        // Role headers appear in conversation order.
        let youRange = plain.range(of: "You")!
        let assistantRange = plain.range(of: "Assistant")!
        let toolRange = plain.range(of: "Tool · run_command")!
        #expect(youRange.lowerBound < assistantRange.lowerBound)
        #expect(assistantRange.lowerBound < toolRange.lowerBound)

        // Prose before code before trailing prose within the assistant message.
        let planRange = plain.range(of: "Here is the plan.")!
        let codeRange = plain.range(of: "threads.sort")!
        let trailingRange = plain.range(of: "That should pin the order.")!
        #expect(planRange.lowerBound < codeRange.lowerBound)
        #expect(codeRange.lowerBound < trailingRange.lowerBound)
        #expect(trailingRange.lowerBound < toolRange.lowerBound)
    }

    @Test("includes file-change diff lines as one multi-line block")
    func fileChangeDiffBlock() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let detail = """
            Edit: {"file_path":"SidebarView.swift","old_string":"let a = 1\\nlet b = 2","new_string":"let a = 2\\nlet b = 3"}
            """
        let items: [TimelineDisplayItem] = [
            .single(
                .toolEvent(
                    id: "t1", name: "edit_file", detail: detail,
                    kind: .fileChange, status: .succeeded, at: now,
                    output: nil, outputIsError: false)),
        ]

        let plain = TranscriptTextBuilder.attributedString(from: items).string
        #expect(plain.contains("SidebarView.swift"))
        #expect(plain.contains("- let a = 1"))
        #expect(plain.contains("- let b = 2"))
        #expect(plain.contains("+ let a = 2"))
        #expect(plain.contains("+ let b = 3"))
        // Multi-line selection requires real newlines between lines.
        #expect(plain.contains("- let a = 1\n- let b = 2"))
        #expect(plain.contains("+ let a = 2\n+ let b = 3"))
    }

    @Test("ignores visual separators and preserves pre-branch tool grouping")
    func separatorsDoNotChangeSerializedText() {
        let firstAt = Date(timeIntervalSince1970: 1_700_000_000)
        let secondAt = firstAt.addingTimeInterval(2 * 60 * 60)
        let rawItems: [TimelineItem] = [
            .toolEvent(
                id: "tool-1", name: "Bash", detail: "pwd", kind: .command,
                status: .succeeded, at: firstAt, output: nil, outputIsError: false),
            .toolEvent(
                id: "tool-2", name: "Bash", detail: "ls", kind: .command,
                status: .succeeded, at: secondAt, output: nil, outputIsError: false),
            .assistantMessage(
                id: "assistant", markdown: "Done", isStreaming: false, at: secondAt),
        ]

        let withVisualSeparator = rawItems.groupedForDisplay()
        let rawText = TranscriptTextBuilder.attributedString(from: rawItems).string
        let displayText = TranscriptTextBuilder.attributedString(from: withVisualSeparator).string

        #expect(rawText == displayText)
        #expect(rawText.contains("Tools"))
        #expect(!rawText.contains("Today"))
    }
}

@Suite("File change diff text")
struct FileChangeDiffTextTests {

    @Test("joins lines with newlines for multi-line selection")
    func joinsLines() {
        let attributed = FileChangeDiffText.attributedBody([
            (.removed, "old line"),
            (.added, "new line"),
            (.separator, "···"),
            (.added, "more"),
        ])
        let plain = String(attributed.characters)
        #expect(plain == "- old line\n+ new line\n···\n+ more")
    }
}
