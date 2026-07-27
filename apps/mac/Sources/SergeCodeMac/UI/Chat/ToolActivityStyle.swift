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
    /// Glyph for this kind, split out from the tint so presentation code that
    /// cannot name a `Color` (the pure `AgentActivityPresentation` policy)
    /// still points at the same symbol the chip draws.
    var activitySymbolName: String {
        switch self {
        case .command: "terminal"
        case .fileChange: "square.and.pencil"
        case .fileRead: "eye"
        case .webSearch: "globe"
        case .mcpCall: "wrench.adjustable"
        case .skill: "wand.and.stars"
        case .computerUse: "desktopcomputer"
        case .subagent: "person.2"
        case .imageView: "photo"
        case .other: "hammer"
        }
    }

    /// Palette assignment keeps related actions in related hues: filesystem
    /// work in greens, network/research in lavender, shell/system in sky,
    /// integrations and imagery in clay.
    var activityTint: Color {
        switch self {
        case .command: AlpineTheme.sky
        case .fileChange: AlpineTheme.meadow
        case .fileRead: AlpineTheme.lichen
        case .webSearch: AlpineTheme.lavender
        case .mcpCall: AlpineTheme.clay
        case .skill: AlpineTheme.accent
        case .computerUse: AlpineTheme.sky
        case .subagent: AlpineTheme.lavender
        case .imageView: AlpineTheme.clay
        case .other: .secondary
        }
    }

    var activityStyle: ToolActivityStyle {
        ToolActivityStyle(symbolName: activitySymbolName, tint: activityTint)
    }

    /// Round-trip back to the wire item type for `ParsedToolDetail`'s hint.
    /// Shared by the transcript row and the live activity dock, which parse
    /// the same detail string for the same reason.
    var wireItemType: String? {
        switch self {
        case .command: "command_execution"
        case .fileChange: "file_change"
        case .fileRead: "file_read"
        case .webSearch: "web_search"
        case .mcpCall: "mcp_tool_call"
        case .subagent: "collab_agent_tool_call"
        case .imageView: "image_view"
        case .skill, .computerUse, .other: nil
        }
    }
}

/// Shape, size and fill shared by every leading activity badge: the static
/// `ActivityIconChip` on transcript rows and the live dock's `AuroraChip`.
///
/// One definition because the two stack in the same column, the dock's badge
/// sitting directly under the last row's, where a point of difference in
/// radius or tint strength reads immediately as a mistake.
enum ActivityChipMetrics {
    static let size = TranscriptMetrics.iconColumn
    static let strokeOpacity = 0.35

    static func cornerRadius(size: CGFloat = size) -> CGFloat { size * 0.32 }

    static func shape(size: CGFloat = size) -> RoundedRectangle {
        RoundedRectangle(cornerRadius: cornerRadius(size: size), style: .continuous)
    }

    static func glyphFont(size: CGFloat = size) -> Font {
        .system(size: size * 0.46, weight: .semibold)
    }

    static func fill(tint: Color) -> LinearGradient {
        LinearGradient(
            colors: [tint.opacity(0.30), tint.opacity(0.12)],
            startPoint: .topLeading,
            endPoint: .bottomTrailing)
    }
}

/// Squircle badge leading every activity row: a kind-tinted gradient tile
/// with the tool glyph. Deliberately bolder than the old 16pt glyph column —
/// the stream should be glanceable from across the room.
struct ActivityIconChip: View {
    let style: ToolActivityStyle
    var size: CGFloat = ActivityChipMetrics.size

    var body: some View {
        Image(systemName: style.symbolName)
            .font(ActivityChipMetrics.glyphFont(size: size))
            .foregroundStyle(style.tint)
            .frame(width: size, height: size)
            .background(
                ActivityChipMetrics.fill(tint: style.tint),
                in: ActivityChipMetrics.shape(size: size))
            .overlay(
                ActivityChipMetrics.shape(size: size)
                    .strokeBorder(
                        style.tint.opacity(ActivityChipMetrics.strokeOpacity),
                        lineWidth: 0.5))
    }
}
