import SwiftUI

/// The app's visual identity: refined alpine-nature look built around
/// Dolomites photography (see SceneryStore). This file holds the non-photo
/// half — accent color and duotone gradient washes used wherever a photo
/// hasn't loaded yet (or the Unsplash key is absent), so the app degrades to
/// the same palette instead of gray placeholders.
enum AlpineTheme {
    struct RGB: Equatable {
        var red: Double
        var green: Double
        var blue: Double

        var color: Color {
            Color(red: red, green: green, blue: blue)
        }

        /// `#RRGGBB` for persistence (project prefs, palette manifests).
        var hexString: String {
            let r = min(255, max(0, Int((red * 255).rounded())))
            let g = min(255, max(0, Int((green * 255).rounded())))
            let b = min(255, max(0, Int((blue * 255).rounded())))
            return String(format: "#%02X%02X%02X", r, g, b)
        }

        init(red: Double, green: Double, blue: Double) {
            self.red = red
            self.green = green
            self.blue = blue
        }

        init?(hex: String) {
            let value = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
            guard value.count == 6, let packed = UInt64(value, radix: 16) else { return nil }
            red = Double((packed >> 16) & 0xFF) / 255
            green = Double((packed >> 8) & 0xFF) / 255
            blue = Double(packed & 0xFF) / 255
        }
    }

    struct GradientPair: Equatable {
        var top: RGB
        var bottom: RGB
    }

    // MARK: - Nature palette

    /// Soft meadow sage — the stable app-wide tint. Scenery can still color
    /// its own artwork and washes, but primary controls no longer change
    /// identity as the selected thread's photograph changes.
    static let accent = Color(red: 0.57, green: 0.79, blue: 0.64)

    /// Deeper foliage used when pastel surfaces need a high-contrast
    /// foreground rather than white text.
    static let forest = Color(red: 0.08, green: 0.22, blue: 0.14)

    /// Pastel nature tones for secondary, semantic accents.
    static let meadow = Color(red: 0.47, green: 0.72, blue: 0.55)
    static let sky = Color(red: 0.57, green: 0.75, blue: 0.78)
    static let clay = Color(red: 0.82, green: 0.60, blue: 0.49)
    static let lichen = Color(red: 0.82, green: 0.76, blue: 0.52)
    static let lavender = Color(red: 0.69, green: 0.64, blue: 0.76)

    /// The user's message is a light sage surface, deliberately distinct from
    /// the darker app tint while remaining part of the same color family.
    static let userBubbleTop = Color(red: 0.72, green: 0.89, blue: 0.76)
    static let userBubbleBottom = Color(red: 0.58, green: 0.81, blue: 0.65)

    /// A restrained, squarer geometry scale for the app's custom surfaces.
    /// Capsules remain reserved for true tags and circular status marks.
    enum Corners {
        static let compact: CGFloat = 5
        static let control: CGFloat = 8
        static let card: CGFloat = 10
        static let composer: CGFloat = 14
        static let hero: CGFloat = 16
    }

    /// Duotone washes sampled from Dolomites conditions: dawn limestone,
    /// glacier melt, high meadow, larch dusk, scree, spruce shade.
    static let dolomitesGradientPairs: [GradientPair] = [
        GradientPair(
            top: RGB(red: 0.93, green: 0.80, blue: 0.71),
            bottom: RGB(red: 0.56, green: 0.55, blue: 0.62)),
        GradientPair(
            top: RGB(red: 0.73, green: 0.85, blue: 0.87),
            bottom: RGB(red: 0.42, green: 0.56, blue: 0.64)),
        GradientPair(
            top: RGB(red: 0.72, green: 0.80, blue: 0.58),
            bottom: RGB(red: 0.36, green: 0.50, blue: 0.40)),
        GradientPair(
            top: RGB(red: 0.89, green: 0.72, blue: 0.51),
            bottom: RGB(red: 0.47, green: 0.42, blue: 0.50)),
        GradientPair(
            top: RGB(red: 0.82, green: 0.81, blue: 0.78),
            bottom: RGB(red: 0.52, green: 0.54, blue: 0.55)),
        GradientPair(
            top: RGB(red: 0.55, green: 0.66, blue: 0.56),
            bottom: RGB(red: 0.25, green: 0.34, blue: 0.32)),
    ]

    /// Deterministic gradient for a seed (thread/photo id): the same entity
    /// always falls back to the same wash across launches.
    static func gradient(seed: String, palette: SceneryPalette? = nil) -> LinearGradient {
        let pair = gradientPair(seed: seed, palette: palette)
        return LinearGradient(
            colors: [pair.top.color, pair.bottom.color],
            startPoint: .topLeading,
            endPoint: .bottomTrailing)
    }

    /// The manifest stores each pair as `[darkBase, lighterWash]`; gradients
    /// keep the established light-top/dark-bottom direction.
    static func gradientPair(seed: String, palette: SceneryPalette?) -> GradientPair {
        let pairs = paletteGradientPairs(palette) ?? dolomitesGradientPairs
        return pairs[stableIndex(seed, pairs.count)]
    }

    /// Palette-colored edge wash for scenery wallpapers. A missing/malformed
    /// palette preserves the original black/white treatment exactly.
    static func sceneryWash(
        seed: String,
        palette: SceneryPalette?,
        colorScheme: ColorScheme
    ) -> Color {
        guard let pairs = paletteGradientPairs(palette) else {
            return colorScheme == .dark ? .black : .white
        }
        let pair = pairs[stableIndex(seed, pairs.count)]
        return colorScheme == .dark ? pair.bottom.color : pair.top.color
    }

    static func accent(palette: SceneryPalette?) -> Color {
        guard let hex = palette?.accentHex, let rgb = RGB(hex: hex) else { return accent }
        return rgb.color
    }

    private static func paletteGradientPairs(_ palette: SceneryPalette?) -> [GradientPair]? {
        guard let washes = palette?.washes else { return nil }
        let pairs = washes.compactMap { pair -> GradientPair? in
            guard pair.count == 2,
                let darkBase = RGB(hex: pair[0]),
                let lighterWash = RGB(hex: pair[1])
            else { return nil }
            return GradientPair(top: lighterWash, bottom: darkBase)
        }
        return pairs.isEmpty ? nil : pairs
    }

    /// FNV-1a over UTF-8, reduced mod `count`. Swift's `hashValue` is
    /// per-launch seeded, so it can't be used for stable assignment.
    static func stableIndex(_ seed: String, _ count: Int) -> Int {
        guard count > 0 else { return 0 }
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in seed.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01B3
        }
        return Int(hash % UInt64(count))
    }
}
