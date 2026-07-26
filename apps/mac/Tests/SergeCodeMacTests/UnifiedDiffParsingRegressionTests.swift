import Foundation
import Testing

@testable import SergeCodeMac

/// Regressions for the unified-diff parser: body lines that look like file
/// headers, section headings in `@@` headers, and the trailing newline every
/// real `git diff` ends with.
@Suite("UnifiedDiffParser regressions")
struct UnifiedDiffParsingRegressionTests {
    @Test("a deleted `-- ` comment line is body, not a file header")
    func deletedDashDashCommentStaysInHunk() {
        let raw = """
            diff --git a/db/m.sql b/db/m.sql
            --- a/db/m.sql
            +++ b/db/m.sql
            @@ -1,5 +1,5 @@
             CREATE TABLE t (
            --- legacy column
            +  id BIGINT
               id INT
             );
            """
        let files = UnifiedDiffParser.parse(raw)
        #expect(files.count == 1)
        #expect(files[0].path == "db/m.sql")
        let lines = files[0].hunks[0].lines
        #expect(lines.count == 5)
        #expect(lines.contains(where: { $0.kind == .deletion && $0.text == "-- legacy column" }))
        #expect(lines.contains(where: { $0.kind == .addition && $0.text == "  id BIGINT" }))
        #expect(lines.contains(where: { $0.kind == .context && $0.text == ");" }))
    }

    @Test("an added `++ ` line does not overwrite the file path")
    func addedPlusPlusLineDoesNotBecomePath() {
        let raw = """
            diff --git a/notes.md b/notes.md
            --- a/notes.md
            +++ b/notes.md
            @@ -1,2 +1,3 @@
             intro
            +++ nested bullet
             outro
            """
        let files = UnifiedDiffParser.parse(raw)
        #expect(files.count == 1)
        #expect(files[0].path == "notes.md")
        let lines = files[0].hunks[0].lines
        #expect(lines.contains(where: { $0.kind == .addition && $0.text == "++ nested bullet" }))
        #expect(lines.count == 3)
    }

    @Test("a `->` in the hunk section heading keeps the real line numbers")
    func sectionHeadingDoesNotZeroLineNumbers() {
        let raw = """
            diff --git a/Lang.swift b/Lang.swift
            --- a/Lang.swift
            +++ b/Lang.swift
            @@ -120,3 +140,3 @@ func language(forPath path: String) -> SyntaxLanguage {
             before
            -old
            +new
            """
        let lines = UnifiedDiffParser.parse(raw)[0].hunks[0].lines
        #expect(lines[0].oldNumber == 120)
        #expect(lines[0].newNumber == 140)
        #expect(lines[1].oldNumber == 121)
        #expect(lines[2].newNumber == 141)
    }

    @Test("a `+` token in the section heading keeps the new-side start")
    func sectionHeadingWithBarePlusKeepsNewStart() {
        let raw = """
            diff --git a/sum.c b/sum.c
            --- a/sum.c
            +++ b/sum.c
            @@ -50,2 +80,2 @@ int sum(int a, int b) { return a + b; }
             ctx
            +added
            """
        let lines = UnifiedDiffParser.parse(raw)[0].hunks[0].lines
        #expect(lines[0].oldNumber == 50)
        #expect(lines[0].newNumber == 80)
        #expect(lines[1].newNumber == 81)
    }

    @Test("the trailing newline of git output is not a context line")
    func trailingNewlineIsNotAPhantomRow() {
        // Deliberately not a multi-line literal: those drop the final newline,
        // which is exactly what hid this bug from the existing tests.
        let raw =
            "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -10,2 +10,2 @@\n-old\n+new\n ctx\n"
        let lines = UnifiedDiffParser.parse(raw)[0].hunks[0].lines
        #expect(lines.count == 3)
        #expect(lines[2].kind == .context)
        #expect(lines[2].text == "ctx")
        #expect(lines[2].oldNumber == 11)
    }

    @Test("a bare unified diff still splits on the `---`/`+++` pair")
    func bareUnifiedDiffStillSplitsFiles() {
        let raw = """
            --- a/one.txt
            +++ b/one.txt
            @@ -1,1 +1,1 @@
            -a
            +b
            --- a/two.txt
            +++ b/two.txt
            @@ -1,1 +1,1 @@
            -c
            +d
            """
        let files = UnifiedDiffParser.parse(raw)
        #expect(files.count == 2)
        #expect(files[0].path == "one.txt")
        #expect(files[1].path == "two.txt")
    }
}
