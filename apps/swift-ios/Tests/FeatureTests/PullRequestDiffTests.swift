import Testing
@testable import T3Code

@Suite("Pull request diff")
struct PullRequestDiffTests {
    @Test
    func parsesFilesAndReviewPositions() throws {
        let patch = """
        diff --git a/Sources/App.swift b/Sources/App.swift
        --- a/Sources/App.swift
        +++ b/Sources/App.swift
        @@ -10,2 +10,3 @@
         let old = true
        -let value = 1
        +let value = 2
        +let extra = true
        """

        let files = PullRequestDiffParser.parse(patch)
        let file = try #require(files.first)

        #expect(file.path == "Sources/App.swift")
        #expect(file.lines.count == 5)
        #expect(file.lines[1].oldLine == 10)
        #expect(file.lines[2].position == .deleted(11))
        #expect(file.lines[3].position == .added(11))
        #expect(file.lines[4].position == .added(12))
    }

    @Test
    func keepsRenamedFileContext() throws {
        let patch = """
        diff --git a/Old.swift b/New.swift
        --- a/Old.swift
        +++ b/New.swift
        @@ -1 +1 @@
        -old
        +new
        """

        let file = try #require(PullRequestDiffParser.parse(patch).first)

        #expect(file.oldPath == "Old.swift")
        #expect(file.path == "New.swift")
    }
}
