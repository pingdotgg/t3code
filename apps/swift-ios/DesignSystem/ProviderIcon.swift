import SwiftUI

enum ProviderInstanceDisplay {
    static func name(instanceID: String, driver: String, displayName: String?) -> String {
        let brand = UsageLimitsPresentation.providerLabel(driver: driver)
        let trimmed = displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let trimmed, !trimmed.isEmpty, trimmed != brand { return trimmed }
        if instanceID != driver {
            let label = instanceID
                .replacingOccurrences(of: "([a-z])([A-Z])", with: "$1 $2", options: .regularExpression)
                .replacingOccurrences(of: "[_-]+", with: " ", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .split(whereSeparator: \.isWhitespace)
                .map { $0.prefix(1).uppercased() + $0.dropFirst() }
                .joined(separator: " ")
            if !label.isEmpty { return label }
        }
        if let trimmed, !trimmed.isEmpty { return trimmed }
        return brand
    }

    static func initials(_ name: String) -> String {
        let words = name.replacingOccurrences(of: "[_-]+", with: " ", options: .regularExpression)
            .split(whereSeparator: \.isWhitespace)
        if words.count == 1 { return String(words[0].prefix(2)).uppercased() }
        return words.prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
    }

    static func accentColor(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              value.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil else { return nil }
        return value
    }
}

struct ProviderAccountBadge: Equatable {
    let initials: String
    let accentColor: String?
}

enum ProviderBrand: String {
    case openAI = "ProviderOpenAI"
    case claude = "ProviderClaude"
    case cursor = "ProviderCursor"
    case grok = "ProviderGrok"
    case openCode = "ProviderOpenCode"
    case antigravity = "ProviderAntigravity"

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
            case "antigravity", "googleantigravity":
                return .antigravity
            default:
                continue
            }
        }
        return nil
    }

    var usesTemplateRendering: Bool {
        switch self {
        case .openAI, .cursor, .grok: true
        case .claude, .openCode, .antigravity: false
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
    var accountBadge: ProviderAccountBadge? = nil

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
        .overlay(alignment: .bottomTrailing) {
            if let accountBadge {
                Text(accountBadge.initials)
                    .font(.system(size: max(8, size * 0.45), weight: .bold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 2)
                    .frame(minWidth: 12, minHeight: 12)
                    .background(badgeColor(accountBadge.accentColor), in: RoundedRectangle(cornerRadius: 3))
                    .overlay {
                        RoundedRectangle(cornerRadius: 3).stroke(T3Colors.background, lineWidth: 1)
                    }
                    .offset(x: 5, y: 5)
            }
        }
        .accessibilityHidden(true)
    }

    private var fallbackInitial: String {
        fallbackName.trimmingCharacters(in: .whitespacesAndNewlines)
            .first
            .map { String($0).uppercased() } ?? "?"
    }

    private func badgeColor(_ value: String?) -> Color {
        guard let value = ProviderInstanceDisplay.accentColor(value),
              let rgb = UInt32(value.dropFirst(), radix: 16) else { return Color(white: 0.3) }
        return Color(red: Double(rgb >> 16) / 255, green: Double((rgb >> 8) & 255) / 255, blue: Double(rgb & 255) / 255)
    }
}
