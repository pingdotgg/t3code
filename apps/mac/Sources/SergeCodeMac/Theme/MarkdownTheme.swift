import SwiftUI

enum MarkdownRenderStyle: Equatable {
    case assistant
    case userBubble
}

enum MarkdownBlockKind: Equatable {
    case paragraph
    case heading(level: Int)
    case listItem
    case taskItem
    case quote
    case rule
    case code
    case table

    static func kind(of block: MarkdownBlock) -> MarkdownBlockKind {
        switch block {
        case .paragraph:
            return .paragraph
        case .heading(let level, _):
            return .heading(level: level)
        case .bulletItem, .orderedItem:
            return .listItem
        case .taskItem:
            return .taskItem
        case .quote:
            return .quote
        case .rule:
            return .rule
        case .codeBlock:
            return .code
        case .table:
            return .table
        }
    }

    var spaceBefore: CGFloat {
        switch self {
        case .paragraph:
            return 12
        case .heading(let level):
            return MarkdownBlockKind.headingSpacing(for: level).before
        case .listItem, .taskItem:
            return 4
        case .quote:
            return 14
        case .rule:
            return 20
        case .code, .table:
            return 14
        }
    }

    var spaceAfter: CGFloat {
        switch self {
        case .paragraph:
            return 12
        case .heading(let level):
            return MarkdownBlockKind.headingSpacing(for: level).after
        case .listItem, .taskItem:
            return 4
        case .quote:
            return 14
        case .rule:
            return 20
        case .code, .table:
            return 14
        }
    }

    var isListKind: Bool {
        switch self {
        case .listItem, .taskItem:
            return true
        default:
            return false
        }
    }

    private static func headingSpacing(for level: Int) -> (before: CGFloat, after: CGFloat) {
        switch max(1, min(level, 6)) {
        case 1:
            return (24, 8)
        case 2:
            return (20, 7)
        case 3:
            return (16, 6)
        default:
            return (14, 6)
        }
    }
}

enum MarkdownTheme {
    enum ForegroundToken: Equatable {
        case primary
        case secondary
        case secondaryOpacity(Double)
        case white
        case whiteOpacity(Double)
        case accentOpacity(Double)
        case separatorOpacity(Double)

        var color: Color {
            switch self {
            case .primary:
                return .primary
            case .secondary:
                return .secondary
            case .secondaryOpacity(let opacity):
                return .secondary.opacity(opacity)
            case .white:
                return .white
            case .whiteOpacity(let opacity):
                return .white.opacity(opacity)
            case .accentOpacity(let opacity):
                return Color.accentColor.opacity(opacity)
            case .separatorOpacity(let opacity):
                return Color(nsColor: .separatorColor).opacity(opacity)
            }
        }
    }

    enum BlockRendering: Equatable {
        case rich
        case plainPanel
    }

    struct StyleTokens: Equatable {
        let proseForeground: ForegroundToken
        let headingForeground: ForegroundToken
        let listMarkerForeground: ForegroundToken
        let taskCheckboxForeground: ForegroundToken
        let checkedTaskTextForeground: ForegroundToken
        let quoteBar: ForegroundToken
        let quoteText: ForegroundToken
        let quoteFill: ForegroundToken
        let headingRule: ForegroundToken
        let rule: ForegroundToken
        let inlineCodeBackground: ForegroundToken?
        let linksAreUnderlined: Bool
        let codeBlock: BlockRendering
        let table: BlockRendering
    }

    static let listBaseIndent: CGFloat = 16
    static let listLevelIndent: CGFloat = 16
    static let listMarkerColumnWidth: CGFloat = 28

    static let quoteBarWidth: CGFloat = 3
    static let quoteCornerRadius: CGFloat = 1.5
    static let quoteAccentOpacity = 0.7
    static let quoteFill = Color.secondary.opacity(0.05)

    static let tableHeaderFill = Color.secondary.opacity(0.08)
    static let tableOddRowFill = Color.secondary.opacity(0.04)

    static func kind(of block: MarkdownBlock) -> MarkdownBlockKind {
        MarkdownBlockKind.kind(of: block)
    }

    /// CSS-like margin collapse for adjacent Markdown blocks.
    static func gap(after: MarkdownBlockKind?, before: MarkdownBlockKind) -> CGFloat {
        guard let after else { return 0 }
        if after.isListKind, before.isListKind {
            return 4
        }
        return max(after.spaceAfter, before.spaceBefore)
    }

    static func tokens(for style: MarkdownRenderStyle) -> StyleTokens {
        switch style {
        case .assistant:
            return StyleTokens(
                proseForeground: .primary,
                headingForeground: .primary,
                listMarkerForeground: .secondary,
                taskCheckboxForeground: .secondary,
                checkedTaskTextForeground: .secondary,
                quoteBar: .accentOpacity(quoteAccentOpacity),
                quoteText: .secondary,
                quoteFill: .secondaryOpacity(0.05),
                headingRule: .separatorOpacity(0.5),
                rule: .separatorOpacity(0.6),
                inlineCodeBackground: nil,
                linksAreUnderlined: false,
                codeBlock: .rich,
                table: .rich)
        case .userBubble:
            return StyleTokens(
                proseForeground: .white,
                headingForeground: .white,
                listMarkerForeground: .whiteOpacity(0.75),
                taskCheckboxForeground: .whiteOpacity(0.75),
                checkedTaskTextForeground: .white,
                quoteBar: .whiteOpacity(0.6),
                quoteText: .whiteOpacity(0.85),
                quoteFill: .whiteOpacity(0.08),
                headingRule: .whiteOpacity(0.35),
                rule: .whiteOpacity(0.35),
                inlineCodeBackground: .whiteOpacity(0.18),
                linksAreUnderlined: true,
                codeBlock: .plainPanel,
                table: .plainPanel)
        }
    }

    static func blockRendering(
        for kind: MarkdownBlockKind,
        style: MarkdownRenderStyle
    ) -> BlockRendering {
        switch kind {
        case .code:
            return tokens(for: style).codeBlock
        case .table:
            return tokens(for: style).table
        default:
            return .rich
        }
    }

    static func headingFont(_ level: Int) -> Font {
        switch max(1, min(level, 6)) {
        case 1:
            return .title.bold()
        case 2:
            return .title2.bold()
        case 3:
            return .title3.weight(.semibold)
        case 4:
            return .headline
        case 5, 6:
            return .subheadline.weight(.semibold)
        default:
            fatalError("heading level is clamped to 1...6")
        }
    }

    static func headingForeground(_ level: Int) -> Color {
        max(1, min(level, 6)) == 6 ? .secondary : .primary
    }

    static func headingForeground(
        _ level: Int,
        style: MarkdownRenderStyle
    ) -> Color {
        guard style == .userBubble else { return headingForeground(level) }
        return tokens(for: style).headingForeground.color
    }

    static func headingHasRule(_ level: Int) -> Bool {
        switch max(1, min(level, 6)) {
        case 1, 2:
            return true
        default:
            return false
        }
    }

    static func listIndent(level: Int) -> CGFloat {
        listBaseIndent + CGFloat(max(0, level)) * listLevelIndent
    }

    static func bulletGlyph(depth: Int) -> String {
        switch max(0, depth) {
        case 0:
            return "●"
        case 1:
            return "◦"
        default:
            return "▪"
        }
    }
}
