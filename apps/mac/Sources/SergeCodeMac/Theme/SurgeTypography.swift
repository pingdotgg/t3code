import AppKit
import CoreText
import SwiftUI

/// Central typography definitions for SurgeCode content surfaces.
///
/// System-facing macOS chrome (toolbars, menus, segmented controls, inspector
/// tabs, dialogs) stays on the system font. These tokens are for branded
/// application content only:
///
/// - Geist Sans for conversations, task titles, project names, empty states,
///   and the composer.
/// - Geist Mono for technical information: branches, model names, tool
///   payloads, paths, code, and command arguments.
///
/// The fonts are bundled under `Vendor/Geist` (SIL OFL, license included) and
/// registered at launch via `registerBundledFonts()`. The app is a
/// hand-assembled SwiftPM bundle, so `ATSApplicationFontsPath` cannot see
/// inside `Bundle.module` — runtime registration works for both `swift run`
/// and the packaged `.app`. Every token falls back to an equivalent system
/// font if a face fails to register.
enum SurgeTypography {

    // MARK: - Registration

    private static let bundledFaces = [
        "Geist-Regular",
        "Geist-Medium",
        "Geist-SemiBold",
        "GeistMono-Regular",
        "GeistMono-Medium",
    ]

    /// Registers the bundled Geist faces with the font manager. Idempotent;
    /// call once at app startup.
    static func registerBundledFonts() {
        for face in bundledFaces {
            guard let url = Bundle.module.url(
                forResource: face, withExtension: "otf", subdirectory: "Geist")
            else { continue }
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
        #if DEBUG
            printAvailableGeistFaces()
        #endif
    }

    // MARK: - Font lookup

    /// Returns a custom font when the requested PostScript name is available.
    /// Falls back to an appropriate macOS system font if the bundled font
    /// is missing, misnamed, or fails to activate.
    private static func customFont(
        _ postScriptName: String,
        size: CGFloat,
        relativeTo textStyle: Font.TextStyle,
        fallbackWeight: Font.Weight,
        fallbackDesign: Font.Design = .default
    ) -> Font {
        guard NSFont(name: postScriptName, size: size) != nil else {
            return .system(
                size: size,
                weight: fallbackWeight,
                design: fallbackDesign
            )
        }

        return .custom(
            postScriptName,
            size: size,
            relativeTo: textStyle
        )
    }

    // MARK: - Titles and navigation content

    static var threadTitle: Font {
        customFont(
            "Geist-SemiBold",
            size: 16,
            relativeTo: .headline,
            fallbackWeight: .semibold
        )
    }

    static var sidebarTaskTitle: Font {
        customFont(
            "Geist-Medium",
            size: 13,
            relativeTo: .body,
            fallbackWeight: .medium
        )
    }

    static var inspectorEmptyStateTitle: Font {
        customFont(
            "Geist-SemiBold",
            size: 15,
            relativeTo: .headline,
            fallbackWeight: .semibold
        )
    }

    // MARK: - Conversation typography

    static var chatBody: Font {
        customFont(
            "Geist-Regular",
            size: 14.5,
            relativeTo: .body,
            fallbackWeight: .regular
        )
    }

    static var chatEmphasis: Font {
        customFont(
            "Geist-SemiBold",
            size: 14.5,
            relativeTo: .body,
            fallbackWeight: .semibold
        )
    }

    static var agentStatus: Font {
        customFont(
            "Geist-Regular",
            size: 13,
            relativeTo: .subheadline,
            fallbackWeight: .regular
        )
    }

    static var composer: Font {
        customFont(
            "Geist-Regular",
            size: 14,
            relativeTo: .body,
            fallbackWeight: .regular
        )
    }

    // MARK: - Tool and technical typography

    static var toolTitle: Font {
        customFont(
            "Geist-Medium",
            size: 13,
            relativeTo: .subheadline,
            fallbackWeight: .medium
        )
    }

    static var technicalMetadata: Font {
        customFont(
            "GeistMono-Medium",
            size: 11.5,
            relativeTo: .caption,
            fallbackWeight: .medium,
            fallbackDesign: .monospaced
        )
    }

    static var toolPayload: Font {
        customFont(
            "GeistMono-Regular",
            size: 12,
            relativeTo: .caption,
            fallbackWeight: .regular,
            fallbackDesign: .monospaced
        )
    }

    static var code: Font {
        code(size: 13)
    }

    /// Geist Mono at an arbitrary size — for zoomable code surfaces (diff
    /// review) that scale their font around a base size.
    static func code(size: CGFloat) -> Font {
        customFont(
            "GeistMono-Regular",
            size: size,
            relativeTo: .body,
            fallbackWeight: .regular,
            fallbackDesign: .monospaced
        )
    }

    // MARK: - Debugging

    /// Font.custom expects an internal/PostScript font name rather than
    /// necessarily the visible filename. Run this in a debug build to verify
    /// the names contained in the bundled font files.
    static func printAvailableGeistFaces() {
        #if DEBUG
            let faces = NSFontManager.shared.availableFonts
                .filter { $0.localizedCaseInsensitiveContains("geist") }
                .sorted()

            if faces.isEmpty {
                print("No Geist font faces are currently registered.")
            } else {
                print("Registered Geist font faces:")
                faces.forEach { print("  • \($0)") }
            }
        #endif
    }
}
