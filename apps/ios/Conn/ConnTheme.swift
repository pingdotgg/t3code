import SwiftUI

struct ConnTheme: Sendable, Equatable {
    let themeId: String
    let tokens: FfiThemeTokens

    static func resolve(for colorScheme: ColorScheme, preferredDark: String = "dark-ocean", preferredLight: String = "t3-code-light") -> ConnTheme {
        let id = colorScheme == .dark ? preferredDark : preferredLight
        if let tokens = themeTokens(themeId: id) {
            return ConnTheme(themeId: id, tokens: tokens)
        }
        if let fallback = themeTokens(themeId: colorScheme == .dark ? "dark-ocean" : "t3-code-light") {
            return ConnTheme(themeId: id, tokens: fallback)
        }
        fatalError("Built-in Conn theme tokens unavailable")
    }

    var background: Color { Color(ffi: tokens.background) }
    var foreground: Color { Color(ffi: tokens.foreground) }
    var card: Color { Color(ffi: tokens.card) }
    var cardForeground: Color { Color(ffi: tokens.cardForeground) }
    var secondary: Color { Color(ffi: tokens.secondary) }
    var muted: Color { Color(ffi: tokens.muted) }
    var mutedForeground: Color { Color(ffi: tokens.mutedForeground) }
    var accent: Color { Color(ffi: tokens.accent) }
    var accentForeground: Color { Color(ffi: tokens.accentForeground) }
    var primary: Color { Color(ffi: tokens.primary) }
    var primaryForeground: Color { Color(ffi: tokens.primaryForeground) }
    var border: Color { Color(ffi: tokens.border) }
    var destructive: Color { Color(ffi: tokens.destructive) }
    var warning: Color { Color(ffi: tokens.warning) }
    var success: Color { Color(ffi: tokens.success) }
    var info: Color { Color(ffi: tokens.info) }
    var codeBackground: Color { Color(ffi: tokens.codeBackground) }
    var codeForeground: Color { Color(ffi: tokens.codeForeground) }
    var messageSurface: Color { Color(ffi: tokens.messageSurface) }
    var messageForeground: Color { Color(ffi: tokens.messageForeground) }
    var diffAdded: Color { Color(ffi: tokens.diffAdded) }
    var diffRemoved: Color { Color(ffi: tokens.diffRemoved) }
}

extension Color {
    init(ffi: FfiColor) {
        self.init(
            .sRGB,
            red: Double(ffi.r),
            green: Double(ffi.g),
            blue: Double(ffi.b),
            opacity: Double(ffi.a)
        )
    }
}

private struct ConnThemeKey: EnvironmentKey {
    static let defaultValue = ConnTheme.resolve(for: .dark)
}

extension EnvironmentValues {
    var connTheme: ConnTheme {
        get { self[ConnThemeKey.self] }
        set { self[ConnThemeKey.self] = newValue }
    }
}

struct ConnThemeProvider<Content: View>: View {
    @Environment(\.colorScheme) private var colorScheme
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        let resolved = ConnTheme.resolve(for: colorScheme)
        content
            .environment(\.connTheme, resolved)
            .tint(resolved.primary)
    }
}
