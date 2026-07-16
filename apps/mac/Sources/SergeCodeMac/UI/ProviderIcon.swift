import AppKit
import SwiftUI

/// The brand represented by a provider or model. Model identity wins over the
/// runtime provider because proxy-backed providers can expose another vendor's
/// models (for example, a Claude-backed runtime serving a GPT model).
enum ProviderBrand: String, Equatable, Sendable {
    case claude
    case codex
    case openAI
    case grok
    case fugu
    case cursor

    static func resolve(provider: ProviderKind, modelID: String? = nil) -> ProviderBrand {
        if let modelID {
            let id = modelID.lowercased()
            if id.contains("claude") { return .claude }
            if id.contains("grok") { return .grok }
            if id.contains("fugu") { return .fugu }
            if id.contains("codex") { return .codex }
            if id.contains("openai") || id.contains("gpt") || isOpenAIReasoningModel(id) {
                return .openAI
            }
        }

        return switch provider {
        case .claude, .claudeWork, .claudeSynthero: .claude
        case .claudex, .codex: .codex
        case .grok: .grok
        case .fugu: .fugu
        case .legacyCursor: .cursor
        }
    }

    private static func isOpenAIReasoningModel(_ id: String) -> Bool {
        ["o1", "o3", "o4"].contains { id == $0 || id.hasPrefix("\($0)-") }
    }

    var assetName: String? {
        switch self {
        case .claude: "ProviderClaude"
        case .codex: "ProviderCodex"
        case .openAI: "ProviderOpenAI"
        case .grok: "ProviderGrok"
        case .cursor: "ProviderCursor"
        case .fugu: nil
        }
    }
}

/// A compact, monochrome provider mark that follows the surrounding semantic
/// foreground style in both light and dark appearances.
struct ProviderIcon: View {
    let provider: ProviderKind
    var modelID: String? = nil
    var size: CGFloat = 14

    var body: some View {
        let brand = ProviderBrand.resolve(provider: provider, modelID: modelID)
        Group {
            if let assetName = brand.assetName {
                Image(nsImage: ProviderIconAssets.image(named: assetName))
                    .resizable()
                    .scaledToFit()
            } else {
                Image(systemName: "fish")
                    .resizable()
                    .scaledToFit()
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

@MainActor
private enum ProviderIconAssets {
    private static let cache = NSCache<NSString, NSImage>()

    static func image(named name: String) -> NSImage {
        if let cached = cache.object(forKey: name as NSString) {
            return cached
        }
        guard
            let url = Bundle.module.url(
                forResource: name, withExtension: "svgdata", subdirectory: "SVG"),
            let image = NSImage(contentsOf: url)
        else {
            assertionFailure("Missing provider icon resource: \(name).svgdata")
            return NSImage()
        }
        image.isTemplate = true
        cache.setObject(image, forKey: name as NSString)
        return image
    }
}

/// Provider icon and title for pickers and menus.
struct ProviderLabel: View {
    let provider: ProviderKind
    var modelID: String? = nil
    var title: String? = nil
    var iconSize: CGFloat = 14

    var body: some View {
        HStack(spacing: 7) {
            ProviderIcon(provider: provider, modelID: modelID, size: iconSize)
            Text(title ?? provider.displayName)
        }
    }
}
