import Foundation
import UIKit

/// Resolves the screenshots a build shipped alongside its changelog.
///
/// Images are **not** carried in the payload. The changelog is a base64 string
/// on an Info.plist key, and the history is append-only, so an inline image
/// would weigh on every future build forever — and `xcodebuild` arguments are
/// bounded by `ARG_MAX` (1 MB total on this platform), which a couple of
/// screenshots exhaust. Publishers instead drop the PNGs into the bundle
/// before the archive is signed and reference them by file name.
enum WhatsNewImageStore {
    /// A single screenshot larger than this is ignored rather than loaded; a
    /// changelog must never be able to stall or exhaust the app.
    static let maximumImageBytes = 8 * 1024 * 1024

    /// Resolves a payload-supplied file name inside `directory`, or `nil` when
    /// the name is unusable, missing, not a regular file, or oversized.
    ///
    /// Names are treated as plain file names inside the bundle: anything with a
    /// path separator, any relative traversal, and any control character is
    /// rejected outright rather than resolved.
    static func imageURL(named name: String, in directory: URL) -> URL? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              trimmed != ".",
              trimmed != "..",
              !trimmed.contains("/"),
              !trimmed.contains("\\"),
              trimmed.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) })
        else { return nil }

        let url = directory.appendingPathComponent(trimmed, isDirectory: false)
        guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
              values.isRegularFile == true,
              let size = values.fileSize,
              size > 0,
              size <= maximumImageBytes
        else { return nil }

        return url
    }

    /// The decoded screenshot, or `nil` when the file is missing, oversized, or
    /// not an image the platform can read — in which case the detail page
    /// simply renders without it.
    static func image(named name: String, in directory: URL) -> UIImage? {
        guard let url = imageURL(named: name, in: directory) else { return nil }
        return UIImage(contentsOfFile: url.path)
    }

    static func image(named name: String, in bundle: Bundle = .main) -> UIImage? {
        image(named: name, in: bundle.bundleURL)
    }

    /// The variant matching the current appearance, falling back to the light
    /// one whenever the dark variant is absent from the payload *or* missing
    /// from the bundle — a build that shipped a single screenshot still shows
    /// it in dark mode rather than showing nothing.
    static func image(
        for image: WhatsNewChangelog.Image,
        isDark: Bool,
        in directory: URL
    ) -> UIImage? {
        let resolved = image.name(inDarkMode: isDark)
        if let loaded = self.image(named: resolved, in: directory) { return loaded }
        guard resolved != image.name else { return nil }
        return self.image(named: image.name, in: directory)
    }

    static func image(
        for image: WhatsNewChangelog.Image,
        isDark: Bool,
        in bundle: Bundle = .main
    ) -> UIImage? {
        self.image(for: image, isDark: isDark, in: bundle.bundleURL)
    }
}
