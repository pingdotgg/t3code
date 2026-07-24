import SwiftUI

/// Visual identity for a tool kind in the live activity stream: which glyph
/// and which nature-palette tint represent it. Shared by every surface that
/// renders tool activity (timeline rows, collapsed tool groups) so the whole
/// stream reads as one language regardless of provider.
struct ToolActivityStyle: Sendable {
    let symbolName: String
    let tint: Color
}

extension ToolEventKind {
    /// Palette assignment keeps related actions in related hues: filesystem
    /// work in greens, network/research in lavender, shell/system in sky,
    /// integrations and imagery in clay.
    var activityStyle: ToolActivityStyle {
        switch self {
        case .command: ToolActivityStyle(symbolName: "terminal", tint: AlpineTheme.sky)
        case .fileChange: ToolActivityStyle(symbolName: "square.and.pencil", tint: AlpineTheme.meadow)
        case .fileRead: ToolActivityStyle(symbolName: "eye", tint: AlpineTheme.lichen)
        case .webSearch: ToolActivityStyle(symbolName: "globe", tint: AlpineTheme.lavender)
        case .mcpCall: ToolActivityStyle(symbolName: "wrench.adjustable", tint: AlpineTheme.clay)
        case .skill: ToolActivityStyle(symbolName: "wand.and.stars", tint: AlpineTheme.accent)
        case .computerUse: ToolActivityStyle(symbolName: "desktopcomputer", tint: AlpineTheme.sky)
        case .subagent: ToolActivityStyle(symbolName: "person.2", tint: AlpineTheme.lavender)
        case .imageView: ToolActivityStyle(symbolName: "photo", tint: AlpineTheme.clay)
        case .other: ToolActivityStyle(symbolName: "hammer", tint: .secondary)
        }
    }
}

/// Squircle badge leading every activity row: a kind-tinted gradient tile
/// with the tool glyph. Deliberately bolder than the old 16pt glyph column —
/// the stream should be glanceable from across the room.
struct ActivityIconChip: View {
    let style: ToolActivityStyle
    var size: CGFloat = TranscriptMetrics.iconColumn

    private var cornerRadius: CGFloat { size * 0.32 }

    var body: some View {
        Image(systemName: style.symbolName)
            .font(.system(size: size * 0.46, weight: .semibold))
            .foregroundStyle(style.tint)
            .frame(width: size, height: size)
            .background(
                LinearGradient(
                    colors: [style.tint.opacity(0.30), style.tint.opacity(0.12)],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing),
                in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .strokeBorder(style.tint.opacity(0.35), lineWidth: 0.5))
    }
}
