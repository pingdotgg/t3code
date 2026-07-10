import Testing

@testable import T3Kit

@Suite("PathDisplay.short")
struct PathDisplayTests {
    @Test func relativeToProjectRoot() {
        let root = "/Users/serge/proj"
        #expect(
            PathDisplay.short(
                "/Users/serge/proj/apps/mac/Sources/Foo.swift",
                projectRoot: root)
                == "apps/mac/Sources/Foo.swift")
        #expect(
            PathDisplay.short("/Users/serge/proj/README.md", projectRoot: root)
                == "README.md")
    }

    @Test func rootWithTrailingSlashStillStrips() {
        #expect(
            PathDisplay.short(
                "/Users/serge/proj/src/a.swift",
                projectRoot: "/Users/serge/proj/")
                == "src/a.swift")
    }

    @Test func pathEqualToRootReturnsLastComponent() {
        #expect(
            PathDisplay.short("/Users/serge/proj", projectRoot: "/Users/serge/proj")
                == "proj")
    }

    @Test func absoluteWithoutMatchingRootUsesLastTwoComponents() {
        #expect(
            PathDisplay.short(
                "/Users/serge/proj/apps/mac/Sources/Foo.swift",
                projectRoot: nil)
                == "Sources/Foo.swift")
        #expect(
            PathDisplay.short(
                "/Users/serge/proj/apps/mac/Sources/Foo.swift",
                projectRoot: "/other/root")
                == "Sources/Foo.swift")
        #expect(
            PathDisplay.short("/tmp/only-one", projectRoot: nil)
                == "tmp/only-one")
        #expect(
            PathDisplay.short("/solo", projectRoot: nil)
                == "solo")
    }

    @Test func nonAbsoluteAndAlreadyShortPassThrough() {
        #expect(
            PathDisplay.short("src/a.swift", projectRoot: "/Users/serge/proj")
                == "src/a.swift")
        #expect(
            PathDisplay.short("a.swift", projectRoot: nil)
                == "a.swift")
        #expect(
            PathDisplay.short("Sources/SergeCodeMac/UI/Chat/Row.swift", projectRoot: nil)
                == "Sources/SergeCodeMac/UI/Chat/Row.swift")
    }

    @Test func emptyAndWhitespace() {
        #expect(PathDisplay.short("", projectRoot: "/root") == "")
        #expect(PathDisplay.short("   ", projectRoot: nil) == "   ")
    }
}
