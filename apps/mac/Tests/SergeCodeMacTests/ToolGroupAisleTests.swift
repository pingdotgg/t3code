import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Tool group aisles")
@MainActor
struct ToolGroupAisleTests {
    private let baseDate = Date(timeIntervalSince1970: 1_700_000_000)

    private func tool(
        id: String,
        kind: ToolEventKind = .command,
        detail: String = "ls",
        status: ToolEventStatus = .succeeded
    ) -> TimelineItem {
        .toolEvent(
            id: id, name: "Tool", detail: detail, kind: kind, status: status,
            at: baseDate, output: nil, outputIsError: false)
    }

    @Test("aisles come from parsed edit paths, first-touch order, deduped")
    func aislesFromEditPaths() {
        let summary = [TimelineItem].toolGroupSummary(of: [
            tool(
                id: "t1", kind: .fileChange,
                detail: #"Edit: {"file_path": "Sources/UI/Chat/Foo.swift", "old_string": "a", "new_string": "b"}"#),
            tool(
                id: "t2", kind: .fileChange,
                detail: #"Edit: {"file_path": "Sources/UI/Chat/Bar.swift", "old_string": "a", "new_string": "b"}"#),
            tool(
                id: "t3", kind: .fileChange,
                detail: #"Edit: {"file_path": "Sources/Model/Baz.swift", "old_string": "a", "new_string": "b"}"#),
        ])

        #expect(summary.aisles == ["UI/Chat", "Sources/Model"])
        #expect(summary.editedFileCount == 3)
    }

    @Test("a bare-path file read contributes an aisle; prose details do not")
    func fileReadHeuristic() {
        let summary = [TimelineItem].toolGroupSummary(of: [
            tool(id: "t1", kind: .fileRead, detail: "Sources/Model/Entities.swift"),
            tool(id: "t2", kind: .fileRead, detail: "Reading two files at once"),
        ])

        #expect(summary.aisles == ["Sources/Model"])
        #expect(summary.editedFileCount == 0)
    }

    @Test("a truncated edit payload still counts as a file but yields no aisle")
    func truncatedPayloadNoAisle() {
        let summary = [TimelineItem].toolGroupSummary(of: [
            tool(
                id: "t1", kind: .fileChange,
                detail: #"Edit: {"file_path": "src/a.swift", "old_string": "let x ..."#)
        ])

        #expect(summary.editedFileCount == 1)
        #expect(summary.aisles.isEmpty)
    }

    @Test("aisle labels are the parent directory's last two components")
    func aisleLabelShapes() {
        #expect(ToolGroupAisles.label(forPath: "a/b/c/d/File.swift") == "c/d")
        #expect(ToolGroupAisles.label(forPath: "src/File.swift") == "src")
        #expect(ToolGroupAisles.label(forPath: "/deep/abs/path/File.swift") == "abs/path")
        #expect(ToolGroupAisles.label(forPath: "File.swift") == nil)
        #expect(ToolGroupAisles.label(forPath: "a/directory/") == nil)
        #expect(ToolGroupAisles.label(forPath: "  ") == nil)
    }

    @Test("headline appends up to two aisles with an overflow count")
    func headlineWithAisles() {
        let two = ToolGroupSummary(
            toolCount: 6, editedFileCount: 3, failedCount: 0, aisles: ["UI/Chat", "Model"])
        #expect(two.headline == "Ran 6 tools · edited 3 files · in UI/Chat, Model")

        let overflow = ToolGroupSummary(
            toolCount: 9, editedFileCount: 4, failedCount: 1,
            aisles: ["UI/Chat", "Model", "Theme", "Support"])
        #expect(overflow.headline == "Ran 9 tools · edited 4 files · 1 failed · in UI/Chat, Model +2")

        let none = ToolGroupSummary(toolCount: 2, editedFileCount: 0, failedCount: 0)
        #expect(none.headline == "Ran 2 tools")
    }
}
