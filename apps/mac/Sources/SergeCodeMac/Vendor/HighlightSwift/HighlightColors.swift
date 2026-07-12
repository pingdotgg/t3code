import SwiftUI

public struct HighlightColors: Hashable, Sendable {
    public let css: String
    public let background: String

    public static func dark(_ theme: HighlightTheme) -> HighlightColors {
        HighlightColors(
            css: HighlightCSS.dark(theme),
            background: HighlightBackground.dark(theme)
        )
    }

    public static func light(_ theme: HighlightTheme) -> HighlightColors {
        HighlightColors(
            css: HighlightCSS.light(theme),
            background: HighlightBackground.light(theme)
        )
    }

    public static func custom(css: String, background: String = "") -> HighlightColors {
        HighlightColors(css: css, background: background)
    }
}
