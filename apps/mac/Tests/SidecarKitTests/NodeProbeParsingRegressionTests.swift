import Testing

@testable import SidecarKit

@Suite("Login-shell node probe parsing")
struct NodeProbeParsingRegressionTests {
    @Test("takes the path from the last non-empty line, ignoring rc chatter")
    func ignoresRcBanners() {
        // `/bin/zsh -ilc` sources ~/.zshrc, so version managers, greetings and
        // fastfetch-style banners land on stdout before `command -v node`.
        #expect(
            NodeRuntimeLocator.nodePath(
                fromLoginShellOutput: """
                    Now using node v22.16.0 (npm v10.9.2)
                    /Users/x/.nvm/versions/node/v22.16.0/bin/node
                    """) == "/Users/x/.nvm/versions/node/v22.16.0/bin/node")
    }

    @Test("tolerates trailing newlines and blank lines")
    func toleratesTrailingBlankLines() {
        #expect(
            NodeRuntimeLocator.nodePath(fromLoginShellOutput: "/opt/homebrew/bin/node\n\n")
                == "/opt/homebrew/bin/node")
        #expect(
            NodeRuntimeLocator.nodePath(fromLoginShellOutput: "\r\n/usr/local/bin/node\r\n")
                == "/usr/local/bin/node")
    }

    @Test("strips surrounding whitespace on the path line")
    func trimsWhitespace() {
        #expect(
            NodeRuntimeLocator.nodePath(fromLoginShellOutput: "banner\n  /usr/local/bin/node  \n")
                == "/usr/local/bin/node")
    }

    @Test(
        "rejects output whose last line is not an absolute path",
        arguments: [
            "",
            "\n\n",
            "node not found",
            "Welcome back, x",
            "node: aliased to /usr/local/bin/node",
            "./node",
        ]
    )
    func rejectsNonPaths(output: String) {
        #expect(NodeRuntimeLocator.nodePath(fromLoginShellOutput: output) == nil)
    }
}
