import Testing
@testable import T3Code

@Suite("Codex follow-up directives")
struct CodexFollowUpDirectiveTests {
    @Test func followUpsShowLabelMarkdownAndHidePrompt() {
        let source = #"Next: :codex-followup[Review **document**]{prompt="Review it."} and :codex-followup[Print version]{prompt='Prepare a } print version.'}."#

        #expect(MarkdownDocument(parsing: source).blocks == [
            .paragraph("Next: Review **document** and Print version."),
        ])
    }

    @Test func malformedAndEmptyFollowUpsStayLiteral() {
        for source in [
            #":codex-followup[Review]"#,
            #":codex-followup[]{prompt="Review it."}"#,
            #":codex-followup[ ]{prompt="Review it."}"#,
            #":codex-followup[Review]{prompt=""}"#,
            #":codex-followup[Review]{prompt=" "}"#,
            #":codex-followup[Review]{prompt="unfinished"#,
            #":codex-followup-extra[Review]{prompt="Review it."}"#,
        ] {
            #expect(CodexMarkdownDirectives.replacingFileCitations(in: source) == source)
        }
    }

    @Test func escapedAndCodeFollowUpsStayLiteral() {
        let directive = #":codex-followup[Review]{prompt="Review it."}"#
        for source in [
            "\\\(directive)", "`\(directive)`", "``\(directive)``", "    \(directive)",
            "```text\n\(directive)\n```", "~~~text\n\(directive)\n~~~",
        ] {
            #expect(CodexMarkdownDirectives.replacingFileCitations(in: source) == source)
        }
    }

    @Test func followUpsRenderInsideLinksWhileCitationsStayLiteral() {
        let directive = #":codex-followup[Review **document**]{prompt="Review it."}"#
        let citation = #":codex-file-citation{path="report.md"}"#
        let source = "[\(directive) \(citation)](https://example.com)"

        #expect(CodexMarkdownDirectives.replacingFileCitations(in: source)
            == "[Review **document** \(citation)](https://example.com)")
    }
}
