import Foundation
import Testing

@testable import SergeCodeMac

@Suite("GitHub comment Markdown")
struct GitHubCommentMarkdownTests {
    @Test("removes bot metadata and preserves CodeRabbit block structure")
    func codeRabbitComment() throws {
        let source = """
            <!-- This is an auto-generated comment: skip review by coderabbit.ai -->
            > [!IMPORTANT]
            > Review skipped
            >
            > Draft detected.

            <details>
            <summary>⚙️ Run configuration</summary>

            - Configuration used: `.coderabbit.yaml`
            - Review profile: CHILL
            </details>

            - [ ] <!-- {"checkboxId": "retry"} --> 🔍 Trigger review
            <!-- end of auto-generated comment: skip review by coderabbit.ai -->
            """

        let normalized = renderableGitHubCommentMarkdown(source)
        #expect(!normalized.contains("<!--"))
        #expect(!normalized.contains("<details>"))
        #expect(!normalized.contains("<summary>"))
        #expect(normalized.contains("> **IMPORTANT**"))
        #expect(normalized.contains("**⚙️ Run configuration**"))

        let blocks = parseMarkdownBlocks(normalized)
        #expect(blocks.count == 5)

        guard case .quote(let alert) = blocks[0],
            case .paragraph(let summary) = blocks[1],
            case .bulletItem(indent: 0, text: let configuration) = blocks[2],
            case .bulletItem(indent: 0, text: let profile) = blocks[3],
            case .taskItem(indent: 0, checked: false, text: let retry) = blocks[4]
        else {
            Issue.record("expected a quote, details summary, list, and retry task")
            return
        }

        #expect(alert.map(text) == ["IMPORTANT Review skipped", "Draft detected."])
        #expect(text(summary) == "⚙️ Run configuration")
        #expect(summary.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
        #expect(text(configuration) == "Configuration used: .coderabbit.yaml")
        #expect(text(profile) == "Review profile: CHILL")
        #expect(text(retry) == "🔍 Trigger review")
    }

    @Test("unwraps nested details and GitHub tip text")
    func nestedDetailsAndSubscript() {
        let normalized = renderableGitHubCommentMarkdown(
            "<details><summary>Finishing Touches</summary>\n<details>\n<summary>Tests</summary>\nBody\n</details></details>\n<sub>Comment @coderabbitai help</sub>")

        #expect(!normalized.contains("<"))
        #expect(normalized.contains("**Finishing Touches**"))
        #expect(normalized.contains("**Tests**"))
        #expect(normalized.contains("Body"))
        #expect(normalized.contains("Comment @coderabbitai help"))
    }

    private func text(_ value: AttributedString) -> String {
        String(value.characters)
    }
}
