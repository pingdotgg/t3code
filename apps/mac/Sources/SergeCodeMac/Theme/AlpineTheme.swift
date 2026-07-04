import SwiftUI

/// The app's visual identity: refined alpine-nature look built around
/// Dolomites photography (see SceneryStore). This file holds the non-photo
/// half — accent color and duotone gradient washes used wherever a photo
/// hasn't loaded yet (or the Unsplash key is absent), so the app degrades to
/// the same palette instead of gray placeholders.
enum AlpineTheme {
    /// Alpine moss — the app-wide tint.
    static let accent = Color(red: 0.30, green: 0.46, blue: 0.36)

    /// Duotone washes sampled from Dolomites conditions: dawn limestone,
    /// glacier melt, high meadow, larch dusk, scree, spruce shade.
    private static let washes: [(Color, Color)] = [
        (Color(red: 0.93, green: 0.80, blue: 0.71), Color(red: 0.56, green: 0.55, blue: 0.62)),
        (Color(red: 0.73, green: 0.85, blue: 0.87), Color(red: 0.42, green: 0.56, blue: 0.64)),
        (Color(red: 0.72, green: 0.80, blue: 0.58), Color(red: 0.36, green: 0.50, blue: 0.40)),
        (Color(red: 0.89, green: 0.72, blue: 0.51), Color(red: 0.47, green: 0.42, blue: 0.50)),
        (Color(red: 0.82, green: 0.81, blue: 0.78), Color(red: 0.52, green: 0.54, blue: 0.55)),
        (Color(red: 0.55, green: 0.66, blue: 0.56), Color(red: 0.25, green: 0.34, blue: 0.32)),
    ]

    /// Deterministic gradient for a seed (thread/photo id): the same entity
    /// always falls back to the same wash across launches.
    static func gradient(seed: String) -> LinearGradient {
        let (top, bottom) = washes[stableIndex(seed, washes.count)]
        return LinearGradient(
            colors: [top, bottom], startPoint: .topLeading, endPoint: .bottomTrailing)
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
