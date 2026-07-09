import Foundation
import Testing

@testable import SergeCodeMac

@Suite("UnifiedDiffParser")
struct UnifiedDiffParserTests {
    @Test("parses multi-file unified diff with hunks")
    func parsesMultiFile() {
        let raw = """
            diff --git a/foo.swift b/foo.swift
            index 111..222 100644
            --- a/foo.swift
            +++ b/foo.swift
            @@ -1,3 +1,4 @@
             line1
            -old
            +new
            +extra
             line3
            diff --git a/bar.ts b/bar.ts
            new file mode 100644
            --- /dev/null
            +++ b/bar.ts
            @@ -0,0 +1,2 @@
            +export const x = 1
            +export const y = 2
            """
        let files = UnifiedDiffParser.parse(raw)
        #expect(files.count == 2)
        #expect(files[0].path == "foo.swift")
        #expect(files[0].status == .modified)
        #expect(files[0].hunks.count == 1)
        let lines = files[0].hunks[0].lines
        #expect(lines.contains(where: { $0.kind == .deletion && $0.text == "old" }))
        #expect(lines.contains(where: { $0.kind == .addition && $0.text == "new" }))
        #expect(files[1].path == "bar.ts")
        #expect(files[1].status == .added)
        #expect(files[1].hunks[0].lines.filter { $0.kind == .addition }.count == 2)
    }

    @Test("tracks line numbers from hunk header")
    func lineNumbers() {
        let raw = """
            diff --git a/a.txt b/a.txt
            --- a/a.txt
            +++ b/a.txt
            @@ -10,2 +10,2 @@
            -ten
            +TEN
             eleven
            """
        let files = UnifiedDiffParser.parse(raw)
        let lines = files[0].hunks[0].lines
        #expect(lines[0].oldNumber == 10)
        #expect(lines[0].newNumber == nil)
        #expect(lines[1].oldNumber == nil)
        #expect(lines[1].newNumber == 10)
        #expect(lines[2].oldNumber == 11)
        #expect(lines[2].newNumber == 11)
    }

    @Test("empty diff returns empty array")
    func emptyDiff() {
        #expect(UnifiedDiffParser.parse("").isEmpty)
        #expect(UnifiedDiffParser.parse("\n").isEmpty)
    }

    @Test("deleted file status")
    func deletedFile() {
        let raw = """
            diff --git a/gone.swift b/gone.swift
            deleted file mode 100644
            --- a/gone.swift
            +++ /dev/null
            @@ -1 +0,0 @@
            -bye
            """
        let files = UnifiedDiffParser.parse(raw)
        #expect(files.count == 1)
        #expect(files[0].status == .deleted)
    }
}
