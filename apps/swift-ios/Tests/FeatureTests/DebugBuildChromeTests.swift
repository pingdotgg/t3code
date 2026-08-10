import SwiftUI
import Testing
import UIKit

@testable import T3Code

@Suite("Debug build chrome")
struct DebugBuildChromeTests {
    @Test func debugBuildMarksEveryPrimarySurface() {
        for surface in T3BuildChrome.Surface.allCases {
            let presentation = T3BuildChrome.presentation(
                for: surface,
                isDebugBuild: true
            )

            #expect(presentation == .warning)
            #expect(
                T3BuildChrome.accessibilityValue(
                    for: surface,
                    isDebugBuild: true
                ) == "\(surface.accessibilityName), Development build"
            )
            #expect(
                T3BuildChrome.toolbarColorScheme(
                    for: surface,
                    isDebugBuild: true
                ) == .light
            )
            #expect(
                resolvedComponents(
                    T3BuildChrome.background(
                        for: surface,
                        standard: .pink,
                        warning: .orange,
                        isDebugBuild: true
                    )
                ) == resolvedComponents(.orange)
            )
            #expect(
                resolvedComponents(
                    T3BuildChrome.foreground(
                        for: surface,
                        standard: .white,
                        isDebugBuild: true
                    )
                ) == resolvedComponents(T3Colors.warningForeground)
            )
            #expect(
                T3BuildChrome.contentOpacity(
                    for: surface,
                    standard: 0.76,
                    isDebugBuild: true
                ) == 1
            )
        }
    }

    @Test func releaseBuildLeavesEveryPrimarySurfaceUnmarked() {
        for surface in T3BuildChrome.Surface.allCases {
            let presentation = T3BuildChrome.presentation(
                for: surface,
                isDebugBuild: false
            )

            #expect(presentation == .standard)
            #expect(
                T3BuildChrome.accessibilityValue(
                    for: surface,
                    isDebugBuild: false
                ) == nil
            )
            #expect(
                T3BuildChrome.toolbarColorScheme(
                    for: surface,
                    isDebugBuild: false
                ) == nil
            )
            #expect(
                resolvedComponents(
                    T3BuildChrome.background(
                        for: surface,
                        standard: .pink,
                        warning: .orange,
                        isDebugBuild: false
                    )
                ) == resolvedComponents(.pink)
            )
            #expect(
                resolvedComponents(
                    T3BuildChrome.foreground(
                        for: surface,
                        standard: .white,
                        isDebugBuild: false
                    )
                ) == resolvedComponents(.white)
            )
            #expect(
                T3BuildChrome.contentOpacity(
                    for: surface,
                    standard: 0.76,
                    isDebugBuild: false
                ) == 0.76
            )
        }
    }

    @Test func warningChromeMeetsTextContrastInLightAndDarkAppearances() throws {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let traits = UITraitCollection(userInterfaceStyle: style)
            let background = T3Colors.uiWarning.resolvedColor(with: traits)
            let foreground = T3Colors.uiWarningForeground.resolvedColor(with: traits)
            let scheme: ColorScheme = style == .dark ? .dark : .light

            #expect(try contrastRatio(foreground, background) >= 4.5)
            #expect(
                resolvedComponents(T3Colors.warning(for: scheme), style: style)
                    == resolvedComponents(T3Colors.warning, style: style)
            )
        }
    }

    private func resolvedComponents(
        _ color: Color,
        style: UIUserInterfaceStyle = .light
    ) -> [CGFloat] {
        let resolved = UIColor(color).resolvedColor(
            with: UITraitCollection(userInterfaceStyle: style)
        )
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        resolved.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        return [red, green, blue, alpha]
    }

    private func contrastRatio(_ first: UIColor, _ second: UIColor) throws -> Double {
        let firstLuminance = try relativeLuminance(first)
        let secondLuminance = try relativeLuminance(second)
        let lighter = max(firstLuminance, secondLuminance)
        let darker = min(firstLuminance, secondLuminance)
        return (lighter + 0.05) / (darker + 0.05)
    }

    private func relativeLuminance(_ color: UIColor) throws -> Double {
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        guard color.getRed(&red, green: &green, blue: &blue, alpha: &alpha) else {
            throw ContrastTestError.unresolvedColor
        }

        func linearized(_ component: CGFloat) -> Double {
            let value = Double(component)
            return value <= 0.04045
                ? value / 12.92
                : pow((value + 0.055) / 1.055, 2.4)
        }

        return 0.2126 * linearized(red)
            + 0.7152 * linearized(green)
            + 0.0722 * linearized(blue)
    }
}

private enum ContrastTestError: Error {
    case unresolvedColor
}
