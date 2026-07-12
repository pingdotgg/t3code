import Testing

@testable import SergeCodeMac

@Suite("Subagent model display names")
struct ModelDisplayNameTests {
    @Test("uses the server catalog name for a known slug")
    func usesCatalogName() {
        #expect(
            displayModelName(
                slug: "claude-sonnet-5",
                catalog: ["claude-sonnet-5": "Sonnet 5"]
            ) == "Sonnet 5"
        )
    }

    @Test("falls back to the compact slug for an unknown model")
    func fallsBackForUnknownSlug() {
        #expect(
            displayModelName(slug: "claude-future-model", catalog: [:]) == "future-model"
        )
        #expect(displayModelName(slug: "gpt-5.6-luna", catalog: [:]) == "gpt-5.6-luna")
    }
}
