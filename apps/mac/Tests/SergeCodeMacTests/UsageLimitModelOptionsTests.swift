import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Usage-limit model options")
struct UsageLimitModelOptionsTests {
    @Test func legacyCursorProviderDecodesButIsNotSelectable() throws {
        let provider = try JSONDecoder().decode(
            ProviderKind.self,
            from: Data(#""cursor""#.utf8))

        #expect(provider == .legacyCursor)
        #expect(!ProviderKind.allCases.contains(.legacyCursor))
    }

    private func option(_ id: String, provider: ProviderKind) -> ModelOption {
        ModelOption(
            instanceID: "instance-\(provider.rawValue)",
            modelID: id,
            displayName: id,
            provider: provider,
            isDefault: false)
    }

    @Test("offers every alternative with other providers first and stable ordering")
    func crossProviderEscapeHatchesComeFirst() {
        let available = [
            option("codex-current", provider: .codex),
            option("codex-next", provider: .codex),
            option("claude-first", provider: .claude),
            option("grok", provider: .grok),
            option("claude-second", provider: .claude),
            option("codex-last", provider: .codex),
        ]

        let result = UsageLimitModelOptions.options(
            available: available,
            currentInstanceID: "instance-codex",
            currentModelID: "codex-current",
            exhaustedProvider: .codex)

        #expect(result.map(\.modelID) == [
            "claude-first", "grok", "claude-second", "codex-next", "codex-last",
        ])
    }

    @Test("preserves available-model order when the exhausted provider is unknown")
    func unknownProviderPreservesOrder() {
        let available = [
            option("claude", provider: .claude),
            option("codex-current", provider: .codex),
            option("grok", provider: .grok),
        ]

        let result = UsageLimitModelOptions.options(
            available: available,
            currentInstanceID: "instance-codex",
            currentModelID: "codex-current",
            exhaustedProvider: nil)

        #expect(result.map(\.modelID) == ["claude", "grok"])
    }
}
