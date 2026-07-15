import Testing

@testable import SergeCodeMac

@Suite("Provider brand resolution")
struct ProviderIconTests {
    @Test("Model identity takes precedence over runtime provider")
    func modelIdentityWins() {
        #expect(
            ProviderBrand.resolve(provider: .claudex, modelID: "gpt-5.6-sol") == .openAI)
        #expect(
            ProviderBrand.resolve(provider: .claudex, modelID: "gpt-5.2-codex") == .codex)
        #expect(
            ProviderBrand.resolve(provider: .codex, modelID: "claude-sonnet-5") == .claude)
    }

    @Test("Provider fallback covers every configured provider")
    func providerFallbacks() {
        #expect(ProviderBrand.resolve(provider: .claudeWork) == .claude)
        #expect(ProviderBrand.resolve(provider: .claudeSynthero) == .claude)
        #expect(ProviderBrand.resolve(provider: .codex) == .codex)
        #expect(ProviderBrand.resolve(provider: .grok) == .grok)
        #expect(ProviderBrand.resolve(provider: .fugu) == .fugu)
        #expect(ProviderBrand.resolve(provider: .opencode) == .openCode)
    }

    @Test("OpenAI reasoning model slugs use the OpenAI mark")
    func openAIReasoningModels() {
        #expect(ProviderBrand.resolve(provider: .codex, modelID: "o3") == .openAI)
        #expect(ProviderBrand.resolve(provider: .codex, modelID: "o4-mini") == .openAI)
    }
}
