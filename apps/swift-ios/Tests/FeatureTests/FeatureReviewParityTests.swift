import Foundation
import Testing
@testable import T3Code

@Suite("Review source and range parity")
struct FeatureReviewParityTests {
    private var patch: String {
        """
        diff --git a/file.swift b/file.swift
        --- a/file.swift
        +++ b/file.swift
        @@ -1,2 +1,2 @@
        -old
        +new
         context
        """
    }

    @Test func branchAndWorkingTreeKeepSeparateFilesAndCommentSources() throws {
        let preview = ReviewDiffPreview(cwd: "/repo", generatedAt: "now", sources: [
            .init(id: "uncommitted", kind: "working-tree", title: "Working tree", baseRef: nil, headRef: nil, diff: patch, diffHash: "working", truncated: false),
            .init(id: "branch", kind: "branch-range", title: "Branch", baseRef: "main", headRef: "HEAD", diff: patch, diffHash: "branch", truncated: true),
        ])
        let branch = NativeWorkspaceMapper.review(preview)
        let working = NativeWorkspaceMapper.review(preview, sourceID: "uncommitted")
        #expect(branch.title == "Changes")
        #expect(branch.selectedSourceID == "branch")
        #expect(branch.files.count == 1)
        #expect(branch.isTruncated)
        #expect(working.title == "Uncommitted")
        #expect(working.files.count == 1)
        #expect(branch.files[0].id != working.files[0].id)
        #expect(branch.files[0].sourceBaseReference == "main")
        #expect(branch.files[0].sourceHeadReference == "HEAD")
        #expect(branch.sources?.map(\.id) == ["uncommitted", "branch"])
        let file = branch.files[0]
        let draft = FeatureReviewCommentDraft(filePath: file.path, body: "Fix this", sourceID: file.sourceID!, sourceTitle: file.sourceTitle!)
        guard case .reviewComment(let context) = draft.contextRecord(lines: file.lines).payload else {
            Issue.record("Missing review context"); return
        }
        #expect(context.sectionId == "branch")
        #expect(context.sectionTitle == "Changes")
    }

    @Test func refreshedDiffContentInvalidatesTheHydratedFileIdentity() {
        let first = ReviewCheckpointDiff(threadId: "thread", fromTurnCount: 0, toTurnCount: 1, diff: patch)
        let next = ReviewCheckpointDiff(threadId: "thread", fromTurnCount: 0, toTurnCount: 2, diff: patch.replacingOccurrences(of: "+new", with: "+newer"))
        let firstFile = NativeWorkspaceMapper.review(NativeReviewSources.diffSource(first, id: "full-thread", title: "All turns")).files[0]
        let nextFile = NativeWorkspaceMapper.review(NativeReviewSources.diffSource(next, id: "full-thread", title: "All turns")).files[0]
        #expect(firstFile.path == nextFile.path)
        #expect(firstFile.sourceID == nextFile.sourceID)
        #expect(firstFile.id != nextFile.id)
    }

    @Test func checkpointChoicesUseReadyCompletedV2RunsAndScopeIdentity() throws {
        var thread = try V2Fixture.load("thread-detail-snapshot").decode(OrchestrationThreadDetailSnapshot.self).thread
        func checkpoint(_ id: String, run: String, count: Int, status: String = "ready") -> JSONValue {
            .object(["id": .string(id), "scopeId": .string("scope"), "runId": .string(run), "status": .string(status), "appRunOrdinal": .number(Double(count))])
        }
        thread.orchestrationV2Control = .object([
            "runs": .array([
                .object(["id": .string("done"), "status": .string("completed")]),
                .object(["id": .string("earlier"), "status": .string("completed")]),
                .object(["id": .string("undone"), "status": .string("rolled_back")]),
                .object(["id": .string("active"), "status": .string("running")]),
            ]),
            "checkpoints": .array([
                checkpoint("latest", run: "done", count: 7), checkpoint("old", run: "earlier", count: 2),
                checkpoint("stale", run: "done", count: 8, status: "stale"),
                checkpoint("rollback", run: "undone", count: 9), checkpoint("pending", run: "active", count: 10),
            ]),
        ])
        let sources = NativeReviewSources.checkpoints(thread)
        #expect(sources.map(\.id) == ["checkpoint:scope:latest", "checkpoint:scope:old", "full-thread"])
        #expect(sources[0].target == .turn(checkpointID: "checkpoint:scope:latest", fromTurnCount: 6, toTurnCount: 7))
        #expect(sources[1].title == "Turn 2")
        #expect(sources[2].target == .fullThread(toTurnCount: 7))
    }

    @Test func legacyCheckpointChoicesDoNotRequireV2Projection() throws {
        var thread = try V2Fixture.load("thread-detail-snapshot").decode(OrchestrationThreadDetailSnapshot.self).thread
        thread.orchestrationV2Control = nil
        thread.checkpoints = [
            .init(turnId: "old-turn", checkpointTurnCount: 2, checkpointRef: "refs/checkpoints/2", status: "ready", files: [], assistantMessageId: nil, completedAt: "now"),
            .init(turnId: "missing-turn", checkpointTurnCount: 3, checkpointRef: "refs/checkpoints/3", status: "missing", files: [], assistantMessageId: nil, completedAt: "now"),
        ]
        let sources = NativeReviewSources.checkpoints(thread)
        #expect(sources.count == 2)
        #expect(sources[0].target == .turn(checkpointID: "turn:old-turn:refs/checkpoints/2", fromTurnCount: 1, toTurnCount: 2))
    }

    @Test func reverseRangeKeepsItsSideAndRenderedIndices() throws {
        let anchor = FeatureReviewLineSelection(side: .old, line: 4)
        let range = try #require(anchor.extending(to: .init(side: .old, line: 2)))
        #expect(range.line == 2)
        #expect(range.lastLine == 4)
        #expect(anchor.extending(to: .init(side: .new, line: 2)) == nil)
        let containsOtherSide = range.contains(.init(side: .new, line: 3))
        #expect(!containsOtherSide)
        let rows: [FeatureDiffLine] = [
            .init(id: "h", kind: .hunk, text: "@@ -1,4 +1,2 @@"),
            .init(id: "1", kind: .context, oldLine: 1, newLine: 1, text: "keep"),
            .init(id: "2", kind: .deletion, oldLine: 2, text: "remove two"),
            .init(id: "3", kind: .deletion, oldLine: 3, text: "remove three"),
            .init(id: "4", kind: .deletion, oldLine: 4, text: "remove four"),
            .init(id: "5", kind: .addition, newLine: 2, text: "replacement"),
        ]
        let draft = FeatureReviewCommentDraft(filePath: "file.swift", line: range, body: "Keep these", sourceID: "checkpoint:scope:latest", sourceTitle: "Latest turn (7)")
        guard case .reviewComment(let context) = draft.contextRecord(lines: rows).payload else {
            Issue.record("Missing review context"); return
        }
        #expect(context.startIndex == 2)
        #expect(context.endIndex == 4)
        #expect(context.sectionId == "checkpoint:scope:latest")
        #expect(context.rangeLabel == "old lines 2–4")
        #expect(context.diff.contains("-remove two\n-remove three\n-remove four"))
        #expect(draft.prompt.contains("old lines 2–4"))
    }

    @Test func largeRangeContextRemainsBounded() {
        let rows = (1...100).map { FeatureDiffLine(id: "\($0)", kind: .addition, newLine: $0, text: String(repeating: "🙂", count: 500)) }
        let draft = FeatureReviewCommentDraft(filePath: "large.swift", line: .init(side: .new, line: 10, endLine: 95), body: "Review range")
        guard case .reviewComment(let context) = draft.contextRecord(lines: rows).payload else {
            Issue.record("Missing review context"); return
        }
        #expect(context.startIndex == 9)
        #expect(context.endIndex == 94)
        #expect(context.diff.utf16.count <= 32_000)
        #expect(!context.diff.contains("�"))
    }

    @Test func draftCommentRecordRetainsSourceSelectionAndContentThroughSerialization() throws {
        let rows: [FeatureDiffLine] = [
            .init(id: "hunk", kind: .hunk, text: "@@ -1,2 +1,2 @@"),
            .init(id: "old", kind: .deletion, oldLine: 1, text: "old"),
            .init(id: "new", kind: .addition, newLine: 1, text: "new"),
            .init(id: "context", kind: .context, oldLine: 2, newLine: 2, text: "context"),
        ]
        let draft = FeatureReviewCommentDraft(
            filePath: "src/file.swift", line: .init(side: .new, line: 1, endLine: 2),
            body: "Keep the old behavior.\nExplain the change.",
            sourceID: "checkpoint:scope:latest", sourceTitle: "Latest turn (7)"
        )
        let record = draft.contextRecord(lines: rows)
        let restored = try JSONDecoder().decode(ComposerContextRecord.self, from: JSONEncoder().encode(record))
        #expect(restored == record)
        guard case let .reviewComment(comment) = restored.payload else {
            Issue.record("Missing review context"); return
        }
        #expect(restored.kind == "review-comment")
        #expect(restored.label == "src/file.swift new lines 1–2")
        #expect(comment.sectionId == "checkpoint:scope:latest")
        #expect(comment.sectionTitle == "Latest turn (7)")
        #expect(comment.filePath == "src/file.swift")
        #expect(comment.startIndex == 2)
        #expect(comment.endIndex == 3)
        #expect(comment.rangeLabel == "new lines 1–2")
        #expect(comment.text == draft.body)
        #expect(comment.diff == "@@ -1,2 +1,2 @@\n-old\n+new\n context")
        #expect(comment.fenceLanguage == "diff")
        #expect(comment.pullRequest == nil)

        let text = ComposerContextReferences.ensureReferences("Existing draft", records: [restored])
        #expect(text.hasPrefix("Existing draft "))
        #expect(ComposerContextReferences.collect(text).map(\.contextId) == [record.contextId])
        let context = ComposerContextReferences.referenced(.init(records: [restored]), text: text)
        #expect(context?.records == [record])
        let legacyText = ComposerContextReferences.providerProjection(text, context: context)
        #expect(legacyText.contains("file: src/file.swift"))
        #expect(legacyText.contains("range: new lines 1–2 (2-3)"))
        #expect(legacyText.contains("section: Latest turn (7)"))
        #expect(legacyText.contains("Keep the old behavior.\n  Explain the change."))
        #expect(legacyText.contains("-old\n  +new\n   context"))
    }

    @Test func fileCommentKeepsTheFullAllowedBodyWithoutALineSelection() throws {
        let body = String(repeating: "🙂", count: 8_000)
        let draft = FeatureReviewCommentDraft(filePath: "binary.dat", body: body)
        let record = draft.contextRecord(lines: [])
        guard case let .reviewComment(comment) = record.payload else {
            Issue.record("Missing review context"); return
        }
        #expect(comment.text == body)
        #expect(comment.text.utf16.count == 16_000)
        #expect(comment.rangeLabel == "File")
        #expect(comment.startIndex == 0)
        #expect(comment.endIndex == 0)
        #expect(comment.diff.isEmpty)
        #expect(comment.sectionId == "working-tree")
        #expect(try JSONDecoder().decode(ComposerContextRecord.self, from: JSONEncoder().encode(record)) == record)
    }
}
