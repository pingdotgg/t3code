import Foundation

/// Class whose containing bundle identifies where the SergeCodeMac module
/// was linked: the app itself in normal runs, the `.xctest` bundle under
/// `swift test`. `Bundle.main` cannot serve that purpose in the test runner,
/// which is a bare helper executable whose `resourceURL` is nil.
private final class AppResourceBundleFinder {}

extension Bundle {
    /// The app's SwiftPM resource bundle, located without the
    /// toolchain-generated `Bundle.module` accessor.
    ///
    /// `Bundle.module` is unsafe for this app: its search paths vary across
    /// SwiftPM versions (some probe `Bundle.main.resourceURL`, others only
    /// the app-bundle root and the compile-time build directory), and it
    /// `fatalError`s when none match. Because the `.app` is hand-assembled
    /// by `scripts/make-app.sh`, the generated accessor's assumptions do not
    /// always hold — a release built on CI crashed at launch when
    /// `SurgeTypography.registerBundledFonts()` touched `Bundle.module`.
    ///
    /// Instead we probe the locations that actually contain the bundle:
    /// `Contents/Resources/SergeCodeMac_SergeCodeMac.bundle` in the packaged
    /// app (where `make-app.sh` copies it), the executable's directory for
    /// `swift run`, and the `.xctest` resources for tests (SwiftPM copies it
    /// there). `Bundle(url:)` reads both the structured
    /// (`Contents/Resources`) and flat layouts that different toolchains
    /// emit.
    ///
    /// Returns nil instead of crashing when the bundle is absent, so callers
    /// can degrade gracefully (system-font fallbacks, missing-highlight
    /// errors, placeholder icons).
    static var appResources: Bundle? {
        let bundleName = "SergeCodeMac_SergeCodeMac.bundle"
        let candidates = [
            // Packaged app: Contents/Resources. `swift run`: the
            // executable's directory, where SwiftPM drops the bundle.
            Bundle.main.resourceURL,
            // Test runner: the .xctest bundle's Contents/Resources, via the
            // bundle this module was linked into (Bundle.main is the bare
            // swiftpm-testing-helper there).
            Bundle(for: AppResourceBundleFinder.self).resourceURL,
        ]
        for candidate in candidates {
            guard let candidate else { continue }
            if let bundle = Bundle(
                url: candidate.appendingPathComponent(bundleName, isDirectory: true)
            ) {
                return bundle
            }
        }
        return nil
    }
}
