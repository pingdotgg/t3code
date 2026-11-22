import SwiftUI
import UIKit

/// Renders Conn's custom Superheroicon symbolset from `ConnSymbols.xcassets` when `name` is
/// in `connSymbolNames`, otherwise falls back to SF Symbols. Using `Image(name)` directly
/// ensures SwiftUI resolves the custom symbolset on iOS 26+ (where `Image(systemName:)`
/// bypasses `UIImage.systemImageNamed:` swizzling).
struct ConnIcon: View {
    let name: String

    init(_ name: String) {
        self.name = name
    }

    var body: some View {
        if connSymbolNames.contains(name) {
            Image(name)
                .renderingMode(.template)
        } else {
            Image(systemName: name)
        }
    }
}

/// Returns Conn's custom symbols (ConnSymbols.xcassets, built from the Superheroicons
/// 16px solid set) for every SF Symbol name in `connSymbolNames`, so SwiftUI `Image(systemName:)`,
/// native toolbars, tab bars and menus all draw Conn's icons. Other names stay SF Symbols.
enum ConnSymbols {
    @MainActor private static var installed = false

    @MainActor static func install() {
        guard !installed else { return }
        installed = true
        swap("systemImageNamed:", "conn_systemImageNamed:")
        swap("systemImageNamed:withConfiguration:", "conn_systemImageNamed:withConfiguration:")
        swap(
            "systemImageNamed:compatibleWithTraitCollection:",
            "conn_systemImageNamed:compatibleWithTraitCollection:"
        )
    }

    private static func assetName(_ name: String) -> String? {
        connSymbolNames.contains(name) ? name : nil
    }

    static func image(named name: String, configuration: UIImage.Configuration?) -> UIImage? {
        guard let asset = assetName(name) else { return nil }
        return UIImage(named: asset, in: Bundle.main, with: configuration)
    }

    static func image(named name: String, traitCollection: UITraitCollection?) -> UIImage? {
        guard let asset = assetName(name) else { return nil }
        return UIImage(named: asset, in: Bundle.main, compatibleWith: traitCollection)
    }

    private static func swap(_ original: String, _ replacement: String) {
        guard
            let originalMethod = class_getClassMethod(UIImage.self, NSSelectorFromString(original)),
            let replacementMethod = class_getClassMethod(UIImage.self, NSSelectorFromString(replacement))
        else { return }
        method_exchangeImplementations(originalMethod, replacementMethod)
    }
}

extension UIImage {
    // After `ConnSymbols.install()` these hold the original implementations, so each
    // falls back to the system symbol by calling itself.
    @objc(conn_systemImageNamed:)
    dynamic class func conn_systemImageNamed(_ name: String) -> UIImage? {
        ConnSymbols.image(named: name, configuration: nil) ?? conn_systemImageNamed(name)
    }

    @objc(conn_systemImageNamed:withConfiguration:)
    dynamic class func conn_systemImageNamed(
        _ name: String,
        withConfiguration configuration: UIImage.Configuration?
    ) -> UIImage? {
        ConnSymbols.image(named: name, configuration: configuration)
            ?? conn_systemImageNamed(name, withConfiguration: configuration)
    }

    @objc(conn_systemImageNamed:compatibleWithTraitCollection:)
    dynamic class func conn_systemImageNamed(
        _ name: String,
        compatibleWithTraitCollection traitCollection: UITraitCollection?
    ) -> UIImage? {
        ConnSymbols.image(named: name, traitCollection: traitCollection)
            ?? conn_systemImageNamed(name, compatibleWithTraitCollection: traitCollection)
    }
}
