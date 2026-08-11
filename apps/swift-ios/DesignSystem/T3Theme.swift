import SwiftUI
import UIKit

enum T3Colors {
    // Keep these values aligned with apps/mobile/global.css. UIKit variants
    // let recycled collection and terminal surfaces participate in the same
    // system appearance changes as SwiftUI views.
    static let uiBackground = adaptive(light: rgb(0xF2F2F7), dark: rgb(0x0A0A0A))
    static let uiTextPrimary = adaptive(light: rgb(0x262626), dark: rgb(0xF5F5F5))
    static let uiWarning = adaptive(light: rgb(0xD97706), dark: rgb(0xFF9F0A))
    static let uiWarningForeground = adaptive(light: rgb(0x000000), dark: rgb(0x000000))

    static let background = Color(uiColor: uiBackground)
    static let sheet = color(light: rgb(0xF2F2F7, alpha: 0.98), dark: rgb(0x0E0E0E, alpha: 0.98))
    static let surface = color(light: rgb(0xFFFFFF), dark: rgb(0x171717))
    static let surfaceRaised = color(light: rgb(0xF5F5F5), dark: rgb(0x1C1C1C))
    static let input = color(light: rgb(0xFFFFFF), dark: rgb(0x141414))
    static let border = color(light: rgb(0x000000, alpha: 0.08), dark: rgb(0xFFFFFF, alpha: 0.06))
    static let inputBorder = color(
        light: rgb(0x000000, alpha: 0.10), dark: rgb(0xFFFFFF, alpha: 0.08))
    static let separator = color(
        light: rgb(0x000000, alpha: 0.04), dark: rgb(0xFFFFFF, alpha: 0.03))
    static let subtle = color(light: rgb(0x000000, alpha: 0.04), dark: rgb(0xFFFFFF, alpha: 0.04))
    static let subtleStrong = color(
        light: rgb(0x000000, alpha: 0.08), dark: rgb(0xFFFFFF, alpha: 0.08))
    static let shadow = color(light: rgb(0x000000, alpha: 0.18), dark: rgb(0x000000, alpha: 0.32))
    static let ledgerSurface = surface
    static let ledgerSelected = surfaceRaised

    static let textPrimary = Color(uiColor: uiTextPrimary)
    static let textSecondary = color(light: rgb(0x525252), dark: rgb(0xA3A3A3))
    static let textTertiary = color(light: rgb(0x737373), dark: rgb(0x8E8E93))
    static let placeholder = color(light: rgb(0xA3A3A3), dark: rgb(0x8E8E93))

    static let primaryAction = color(light: rgb(0x262626), dark: rgb(0xF5F5F5))
    static let primaryActionForeground = color(light: rgb(0xFFFFFF), dark: rgb(0x0A0A0A))
    static let accent = color(light: rgb(0x007AFF), dark: rgb(0x0A84FF))
    static let statusRunning = color(light: rgb(0x0284C7), dark: rgb(0x22D3EE))
    static let statusInput = color(light: rgb(0x4F46E5), dark: rgb(0xA5B4FC))
    static let success = color(light: rgb(0x16A34A), dark: rgb(0x30D158))
    static let warning = Color(uiColor: uiWarning)
    static let warningForeground = Color(uiColor: uiWarningForeground)
    static let danger = color(light: rgb(0xDC2626), dark: rgb(0xFF453A))

    static func warning(for colorScheme: ColorScheme) -> Color {
        let traits = UITraitCollection(
            userInterfaceStyle: colorScheme == .dark ? .dark : .light
        )
        return Color(uiColor: uiWarning.resolvedColor(with: traits))
    }

    static let syntaxKeyword = color(light: rgb(0x7C3AED), dark: rgb(0xC78EFF))
    static let syntaxLiteral = color(light: rgb(0x2563EB), dark: rgb(0x8CC7FF))
    static let syntaxNumber = color(light: rgb(0xB45309), dark: rgb(0xEBAA6B))
    static let syntaxProperty = color(light: rgb(0x0F766E), dark: rgb(0x6BD1C2))

    private static func color(light: UIColor, dark: UIColor) -> Color {
        Color(uiColor: adaptive(light: light, dark: dark))
    }

    private static func adaptive(light: UIColor, dark: UIColor) -> UIColor {
        UIColor { traits in
            traits.userInterfaceStyle == .dark ? dark : light
        }
    }

    private static func rgb(_ hex: UInt32, alpha: CGFloat = 1) -> UIColor {
        UIColor(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha
        )
    }
}

enum T3BuildChrome {
    enum Surface: String, CaseIterable, Sendable {
        case home
        case newTask
        case thread

        var accessibilityName: String {
            switch self {
            case .home: "Home"
            case .newTask: "New task"
            case .thread: "Thread"
            }
        }
    }

    enum Presentation: Equatable, Sendable {
        case standard
        case warning
    }

#if DEBUG
    static let isDebugBuild = true
#else
    static let isDebugBuild = false
#endif

    static func presentation(
        for _: Surface,
        isDebugBuild: Bool = isDebugBuild
    ) -> Presentation {
        isDebugBuild ? .warning : .standard
    }

    static func accessibilityValue(
        for surface: Surface,
        isDebugBuild: Bool = isDebugBuild
    ) -> String? {
        guard presentation(for: surface, isDebugBuild: isDebugBuild) == .warning else {
            return nil
        }
        return "\(surface.accessibilityName), Development build"
    }

    static func background(
        for surface: Surface,
        standard: Color,
        warning: Color = T3Colors.warning,
        isDebugBuild: Bool = isDebugBuild
    ) -> Color {
        presentation(for: surface, isDebugBuild: isDebugBuild) == .warning ? warning : standard
    }

    static func foreground(
        for surface: Surface,
        standard: Color,
        isDebugBuild: Bool = isDebugBuild
    ) -> Color {
        presentation(for: surface, isDebugBuild: isDebugBuild) == .warning
            ? T3Colors.warningForeground
            : standard
    }

    static func toolbarColorScheme(
        for surface: Surface,
        isDebugBuild: Bool = isDebugBuild
    ) -> ColorScheme? {
        presentation(for: surface, isDebugBuild: isDebugBuild) == .warning ? .light : nil
    }

    static func contentOpacity(
        for surface: Surface,
        standard: Double,
        isDebugBuild: Bool = isDebugBuild
    ) -> Double {
        presentation(for: surface, isDebugBuild: isDebugBuild) == .warning ? 1 : standard
    }
}

/// The native client uses semantic fonts so every surface follows Dynamic Type.
/// Keep roles here instead of introducing one-off point sizes in feature views.
enum T3Typography {
    static let homeTitle = Font.system(.body, design: .default, weight: .semibold)
    static let homeMetadata = Font.system(.footnote, design: .default)

    static let navigationTitle = Font.system(.headline, design: .default, weight: .semibold)
    static let navigationMetadata = Font.system(.footnote, design: .default)
    static let status = Font.system(.footnote, design: .default, weight: .semibold)

    static let threadBody = Font.system(.body, design: .default)
    static let threadHeading1 = Font.system(.title2, design: .default, weight: .bold)
    static let threadHeading2 = Font.system(.title3, design: .default, weight: .bold)
    static let threadHeading3 = Font.system(.headline, design: .default, weight: .bold)
    static let threadHeading4 = Font.system(.body, design: .default, weight: .semibold)
    static let code = Font.system(.callout, design: .monospaced)
    static let tool = Font.system(.footnote, design: .monospaced)

    static let composer = Font.system(.body, design: .default)
    static let control = Font.system(.callout, design: .default, weight: .medium)
    static let supporting = Font.system(.footnote, design: .default)
    static let supportingStrong = Font.system(.footnote, design: .default, weight: .semibold)
    static let eyebrow = Font.system(.footnote, design: .default, weight: .bold)
}

enum T3Metrics {
    static let minimumTapTarget: CGFloat = 44
    static let sidebarWidth: CGFloat = 320
    static let minimumSidebarWidth: CGFloat = 280
    static let maximumSidebarWidth: CGFloat = 380
    static let readingWidth: CGFloat = 760
}

extension View {
    func t3NavigationChrome(background: Color = T3Colors.sheet) -> some View {
        toolbarBackground(background, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
    }

    func t3BuildNavigationChrome(_ surface: T3BuildChrome.Surface) -> some View {
        modifier(T3BuildNavigationChromeModifier(surface: surface))
    }

    func t3BuildChromeBackground(
        _ surface: T3BuildChrome.Surface,
        standard: Color
    ) -> some View {
        // Keep the Home/New Task warning inside their bars; unlike navigation
        // chrome, those surfaces do not own the status-bar safe area.
        background(
            T3BuildChrome.background(for: surface, standard: standard),
            ignoresSafeAreaEdges: []
        )
    }

    @ViewBuilder
    func t3BuildChromeMarker(_ surface: T3BuildChrome.Surface) -> some View {
        if let value = T3BuildChrome.accessibilityValue(for: surface) {
            accessibilityValue(value)
        } else {
            self
        }
    }
}

private struct T3BuildNavigationChromeModifier: ViewModifier {
    @SwiftUI.Environment(\.colorScheme) private var colorScheme
    let surface: T3BuildChrome.Surface

    func body(content: Content) -> some View {
        content
            .t3NavigationChrome(
                background: T3BuildChrome.background(
                    for: surface,
                    standard: T3Colors.sheet,
                    // Resolve before toolbarColorScheme(.light) changes the
                    // navigation bar's environment and flattens the warning.
                    warning: T3Colors.warning(for: colorScheme)
                )
            )
            .toolbarColorScheme(
                T3BuildChrome.toolbarColorScheme(for: surface),
                for: .navigationBar
            )
    }
}
