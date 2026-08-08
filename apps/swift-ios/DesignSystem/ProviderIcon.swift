import SwiftUI

enum ProviderBrand: String {
    case openAI = "ProviderOpenAI"
    case claude = "ProviderClaude"
    case cursor = "ProviderCursor"
    case grok = "ProviderGrok"
    case openCode = "ProviderOpenCode"

    static func resolve(
        driver: String,
        providerID: String,
        providerName: String = ""
    ) -> ProviderBrand? {
        for value in [driver, providerID, providerName] {
            let normalized = value
                .lowercased()
                .filter(\.isLetter)
            switch normalized {
            case "codex", "codexcli", "openai", "openaicodex":
                return .openAI
            case "anthropic", "anthropicclaude", "claudeagent", "claude", "claudecode":
                return .claude
            case "cursor", "cursoragent":
                return .cursor
            case "grok", "xai", "xaigrok":
                return .grok
            case "opencode":
                return .openCode
            default:
                continue
            }
        }
        return nil
    }

    var usesTemplateRendering: Bool {
        switch self {
        case .openAI, .cursor, .grok: true
        case .claude, .openCode: false
        }
    }
}

/// Displays the same provider artwork used by the web and marketing surfaces.
/// Unknown provider instances retain a compact initial so custom adapters remain legible.
struct ProviderIcon: View {
    let driver: String
    let providerID: String
    let fallbackName: String
    let size: CGFloat

    var body: some View {
        Group {
            if let brand = ProviderBrand.resolve(
                driver: driver,
                providerID: providerID,
                providerName: fallbackName
            ) {
                Image(brand.rawValue)
                    .resizable()
                    .renderingMode(brand.usesTemplateRendering ? .template : .original)
                    .foregroundStyle(T3Colors.textSecondary)
                    .scaledToFit()
            } else {
                Text(fallbackInitial)
                    .font(.system(size: max(9, size * 0.44), weight: .bold))
                    .foregroundStyle(T3Colors.textPrimary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(
                        T3Colors.surfaceRaised,
                        in: RoundedRectangle(cornerRadius: max(4, size * 0.22))
                    )
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private var fallbackInitial: String {
        fallbackName.trimmingCharacters(in: .whitespacesAndNewlines)
            .first
            .map { String($0).uppercased() } ?? "?"
    }
}
