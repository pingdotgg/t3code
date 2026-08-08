import Testing
@testable import T3Code

@Suite("Thread tool state")
struct FeatureToolStateTests {
    @Test
    func fileFilteringKeepsDirectoriesFirstAndHonorsHiddenFiles() {
        let entries = [
            FeatureFileEntry(path: "z.swift", name: "z.swift", kind: .file),
            FeatureFileEntry(path: ".env", name: ".env", kind: .file, isHidden: true),
            FeatureFileEntry(path: "Sources", name: "Sources", kind: .directory),
            FeatureFileEntry(path: "a.swift", name: "a.swift", kind: .file),
        ]

        #expect(entries.featureFiltered(by: "", includesHidden: false).map(\.name) == [
            "Sources", "a.swift", "z.swift",
        ])
        #expect(entries.featureFiltered(by: "env", includesHidden: true).map(\.name) == [".env"])
    }

    @Test
    func filePreviewKindUsesImageMarkdownAndSourceSemantics() {
        #expect(FeatureFilePreviewKind.infer(path: "art/hero.webp") == .image)
        #expect(FeatureFilePreviewKind.infer(path: "README.md") == .markdown)
        #expect(FeatureFilePreviewKind.infer(path: "Package.swift") == .source)
        #expect(FeatureFilePreviewKind.infer(path: "LICENSE") == .plainText)
        #expect(FeatureFilePreviewKind.infer(path: "template", language: "html") == .source)
    }

    @Test
    func sourceHighlighterPreservesTextAndClassifiesStableSpans() {
        let source = """
        let count = 42 // total
        /* first
           second */ return "done"
        """
        let lines = FeatureSourceHighlighter.lines(text: source, language: "swift")

        #expect(lines.map(\.text).joined(separator: "\n") == source)
        #expect(lines[0].spans.contains { $0.text == "let" && $0.kind == .keyword })
        #expect(lines[0].spans.contains { $0.text == "42" && $0.kind == .number })
        #expect(lines[0].spans.last?.kind == .comment)
        #expect(lines[1].spans.allSatisfy { $0.kind == .comment })
        #expect(lines[2].spans.first?.kind == .comment)
        #expect(lines[2].spans.contains { $0.text.contains("return") && $0.kind == .keyword })
        #expect(lines[2].spans.last?.kind == .literal)
    }

    @Test
    func sourceHighlighterRecognizesJSONProperties() {
        let line = FeatureSourceHighlighter.lines(
            text: #"{"enabled": true, "count": 3}"#,
            language: "json"
        )[0]

        #expect(line.spans.contains { $0.text == #""enabled""# && $0.kind == .property })
        #expect(line.spans.contains { $0.text == "true" && $0.kind == .literal })
        #expect(line.spans.contains { $0.text == "3" && $0.kind == .number })
    }

    @Test
    func sourceHighlighterBoundsWorkForLargeMinifiedLines() {
        let source = String(repeating: #"{"value":42}"#, count: 3_000)
        let line = FeatureSourceHighlighter.lines(text: source, language: "json")[0]

        #expect(line.text == source)
        #expect(line.spans == [FeatureSourceSpan(text: source, kind: .plain)])
    }

    @Test
    func reviewTotalsAggregateAcrossFiles() {
        let review = FeatureReview(files: [
            FeatureReviewFile(path: "a.swift", change: .modified, additions: 4, deletions: 1),
            FeatureReviewFile(path: "b.swift", change: .added, additions: 8, deletions: 0),
        ])

        #expect(review.additions == 12)
        #expect(review.deletions == 1)
    }

    @Test
    func wordDiffHighlightsOnlyChangedTokens() {
        let result = FeatureDiffWordHighlighter.spans(
            old: "let color = blue",
            new: "let color = green"
        )

        #expect(result.old.map(\.text).joined() == "let color = blue")
        #expect(result.new.map(\.text).joined() == "let color = green")
        #expect(result.old.filter { $0.kind == .changed }.map(\.text) == ["blue"])
        #expect(result.new.filter { $0.kind == .changed }.map(\.text) == ["green"])
    }

    @Test
    func workspaceReviewMapperPairsReplacementLinesAndCarriesBaseReference() {
        let preview = ReviewDiffPreview(
            cwd: "/tmp/project",
            generatedAt: "2026-08-01T00:00:00Z",
            sources: [
                ReviewDiffSource(
                    id: "working-tree",
                    kind: "working-tree",
                    title: "Working tree",
                    baseRef: "main",
                    headRef: nil,
                    diff: """
                    diff --git a/App.swift b/App.swift
                    --- a/App.swift
                    +++ b/App.swift
                    @@ -1,1 +1,1 @@
                    -let color = blue
                    +let color = green
                    """,
                    diffHash: "hash",
                    truncated: false
                ),
            ]
        )

        let review = NativeWorkspaceMapper.review(preview)
        let deletion = review.files[0].lines.first { $0.kind == .deletion }
        let addition = review.files[0].lines.first { $0.kind == .addition }

        #expect(review.baseReference == "main")
        #expect(review.files[0].sourceKind == "working-tree")
        #expect(review.files[0].sourceBaseReference == "main")
        #expect(deletion?.spans?.filter { $0.kind == .changed }.map(\.text) == ["blue"])
        #expect(addition?.spans?.filter { $0.kind == .changed }.map(\.text) == ["green"])
    }

    @Test
    func fullDiffHydrationRestoresUnchangedRegionsWithoutLosingPatchRows() {
        let file = FeatureReviewFile(
            path: "App.swift",
            change: .modified,
            additions: 1,
            deletions: 1,
            lines: [
                .init(id: "hunk", kind: .hunk, text: "@@ -2,2 +2,2 @@"),
                .init(id: "old", kind: .deletion, oldLine: 2, text: "let color = blue"),
                .init(id: "new", kind: .addition, newLine: 2, text: "let color = green"),
                .init(id: "after", kind: .context, oldLine: 3, newLine: 3, text: "render()"),
            ]
        )

        let lines = FeatureFullDiffHydrator.lines(
            for: file,
            contents: FeatureReviewFileContents(
                oldContents: "import SwiftUI\nlet color = blue\nrender()\nfinish()\n",
                newContents: "import SwiftUI\nlet color = green\nrender()\nfinish()\n"
            )
        )

        #expect(lines.map(\.kind) == [.context, .deletion, .addition, .context, .context])
        #expect(lines.map(\.text) == [
            "import SwiftUI",
            "let color = blue",
            "let color = green",
            "render()",
            "finish()",
        ])
        #expect(lines.last?.oldLine == 4)
        #expect(lines.last?.newLine == 4)
    }

    @Test
    func fullDiffHydrationHandlesWholeAddedAndDeletedFiles() {
        let added = FeatureFullDiffHydrator.lines(
            for: FeatureReviewFile(
                path: "Added.swift",
                change: .added,
                additions: 2,
                deletions: 0
            ),
            contents: FeatureReviewFileContents(
                oldContents: "",
                newContents: "one\ntwo\n"
            )
        )
        let deleted = FeatureFullDiffHydrator.lines(
            for: FeatureReviewFile(
                path: "Deleted.swift",
                change: .deleted,
                additions: 0,
                deletions: 1
            ),
            contents: FeatureReviewFileContents(
                oldContents: "gone\n",
                newContents: ""
            )
        )

        #expect(added.map(\.kind) == [.addition, .addition])
        #expect(added.map(\.newLine) == [1, 2])
        #expect(deleted.map(\.kind) == [.deletion])
        #expect(deleted.map(\.oldLine) == [1])
    }

    @Test
    func fullDiffHydrationKeepsDeletionAtItsPreviousAnchor() {
        let file = FeatureReviewFile(
            path: "App.swift",
            change: .modified,
            additions: 1,
            deletions: 1,
            lines: [
                .init(id: "anchor", kind: .context, oldLine: 2, newLine: 2, text: "two"),
                .init(id: "deleted", kind: .deletion, oldLine: 3, text: "three"),
                .init(id: "later", kind: .addition, newLine: 7, text: "added later"),
            ]
        )

        let lines = FeatureFullDiffHydrator.lines(
            for: file,
            contents: FeatureReviewFileContents(
                oldContents: "one\ntwo\nthree\nfour\nfive\nsix\nseven\n",
                newContents: "one\ntwo\nfour\nfive\nsix\nseven\nadded later\n"
            )
        )

        #expect(lines.firstIndex { $0.id == "deleted" } == 2)
        #expect(lines.prefix(3).map(\.text) == ["one", "two", "three"])
    }

    @Test
    func reviewCommentPromptIncludesActionableFileAndLineContext() {
        let draft = FeatureReviewCommentDraft(
            filePath: "Sources/App.swift",
            line: FeatureReviewLineSelection(side: .new, line: 42),
            body: "  Handle the nil case.  "
        )

        #expect(draft.prompt.contains("`Sources/App.swift` at new line 42"))
        #expect(draft.prompt.contains("Handle the nil case."))
        #expect(!draft.prompt.contains("  Handle the nil case.  "))
    }

    @Test
    func sourceControlActionsReflectRepositoryState() {
        let clean = FeatureSourceControlStatus(branch: "main")
        #expect(clean.availableActions == [.createPullRequest])

        let changed = FeatureSourceControlStatus(
            branch: "feature/native",
            aheadCount: 2,
            behindCount: 1,
            files: [.init(path: "App.swift", state: .modified, isStaged: false)]
        )
        #expect(changed.availableActions.contains(.commit))
        #expect(changed.availableActions.contains(.push))
        #expect(changed.availableActions.contains(.pull))
        #expect(changed.availableActions.contains(.commitPushAndCreatePullRequest))

        var busy = changed
        busy.isBusy = true
        #expect(busy.availableActions.isEmpty)
    }

    @Test
    func terminalPlainTextDropsControlSequences() {
        let prompt = "\u{1B}]0;workspace\u{7}\u{1B}[38;5;221mx\u{8}repo\u{1B}[39m ❯ "
        #expect(TerminalText.plainText(from: prompt) == "repo ❯ ")
    }

    @Test
    func terminalSessionSelectionPrefersAndAllocatesStableIDs() {
        let sessions = [
            FeatureTerminalSnapshot(
                threadID: "thread",
                terminalID: "term-2",
                state: .running,
                title: "Tests"
            ),
            FeatureTerminalSnapshot(
                threadID: "thread",
                terminalID: "default",
                state: .running
            ),
            FeatureTerminalSnapshot(
                threadID: "thread",
                terminalID: "term-3",
                state: .exited
            ),
        ]

        #expect(TerminalSessionList.initialID(in: sessions) == "default")
        #expect(TerminalSessionList.nextID(occupiedIDs: ["default", "term-2", "term-4"]) == "term-3")
        #expect(TerminalSessionList.displayTitle(for: sessions[0]) == "Terminal 2 · Tests")
        #expect(TerminalSessionList.displayTitle(for: sessions[1]) == "Terminal 1")
        #expect(
            TerminalSessionList.fallbackID(in: sessions, excluding: "default") == "term-2"
        )
    }

    @Test
    func terminalSnapshotPreservesVTDataForGhostty() {
        let history = "\u{1B}[31mred\u{1B}[0m\r\n"
        let snapshot = TerminalSessionSnapshot(
            threadId: "thread",
            terminalId: "default",
            cwd: "/repo",
            worktreePath: nil,
            status: .running,
            pid: 123,
            history: history,
            exitCode: nil,
            exitSignal: nil,
            label: "Terminal",
            updatedAt: "2026-08-07T00:00:00Z",
            sequence: 1
        )

        #expect(NativeWorkspaceMapper.terminal(snapshot).buffer == history)
    }
}
