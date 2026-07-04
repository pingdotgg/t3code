import Testing

@testable import SidecarKit

@Suite("Node version predicate")
struct NodeVersionPredicateTests {
    // engines.node from apps/server/package.json: "^22.16 || ^23.11 || >=24.10"
    @Test(
        "satisfies the server's engines range",
        arguments: [
            ("v21.9.0", false),
            ("v20.0.0", false),
            ("v22.15.9", false),
            ("v22.16.0", true),
            ("v22.20.3", true),
            ("v23.10.9", false),
            ("v23.11.0", true),
            ("v23.99.0", true),
            ("v24.9.9", false),
            ("v24.10.0", true),
            ("v24.10.1", true),
            ("v25.0.0", true),
            ("v30.0.0", true),
        ]
    )
    func versionSatisfies(raw: String, expected: Bool) {
        #expect(NodeRuntimeLocator.versionSatisfies(raw) == expected)
    }

    @Test("parses semantic version strings, dropping the leading v and any metadata")
    func parsesVersionString() {
        #expect(SemanticVersion(parsing: "v22.16.0") == SemanticVersion(major: 22, minor: 16, patch: 0))
        #expect(SemanticVersion(parsing: "24.10") == SemanticVersion(major: 24, minor: 10, patch: 0))
        #expect(
            SemanticVersion(parsing: "v23.11.2-rc.1")
                == SemanticVersion(major: 23, minor: 11, patch: 2))
    }

    @Test("rejects malformed version strings")
    func rejectsMalformed() {
        #expect(SemanticVersion(parsing: "not-a-version") == nil)
        #expect(SemanticVersion(parsing: "") == nil)
        #expect(SemanticVersion(parsing: "v22") == nil)
    }
}
