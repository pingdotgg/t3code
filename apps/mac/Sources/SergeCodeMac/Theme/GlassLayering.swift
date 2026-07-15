import SwiftUI

/// How the window's layers stack over the desktop for a given scenery
/// translucency `t` (`ScenerySettingsFile.translucencyRange`).
///
/// Bottom to top:
///  1. behind-window blur — the desktop, blurred by the WindowServer
///     (`BehindWindowVisualEffect`)
///  2. window plate — flat window tone that solidifies the whole window
///     toward the opaque end of the slider
///  3. scenery photo — the location image
///  4. legibility wash — flat tone over the photo so `.primary` text stays
///     readable on top (long-form text never sits on glass, so the wash is
///     what carries its contrast)
///  5. native Liquid Glass — cards, composer, toolbar (`glassEffect`)
///
/// The invariant that makes the slider honest: **everything the app paints
/// behind chat content composites to exactly `t`**, so `1 - t` of the desktop
/// reaches the user. The photo therefore has to give up whatever alpha the
/// wash takes — hence `photoOpacity` solving over-composite for the leftover.
/// Above `plateStart` the plate deliberately breaks the invariant upward: that
/// band is the "make it solid" end of the slider, and it lands at fully opaque
/// at `1.0`.
///
/// `UIProbeGlass` (`SERGECODE_UI_PROBE_SCENARIO=glass`) measures the real
/// composite against this model; `GlassLayeringTests` pins the math.
enum GlassLayering {
    /// Translucency at which the window plate starts solidifying. Below this
    /// the window is pure glass plus the scene; above it the plate ramps in
    /// so `1.0` is the fully solid window.
    static let plateStart: Double = ScenerySettingsFile.defaultTranslucency

    /// Flat wash over the chat wallpaper. Dark mode pulls toward black, light
    /// mode toward white — enough to keep `.primary`/`.secondary` legible over
    /// a bright sky.
    static func chatWashBase(_ colorScheme: ColorScheme) -> Double {
        colorScheme == .dark ? 0.50 : 0.58
    }

    /// Wash at the top/bottom edges of the empty-state hero.
    static let heroWashBaseTop: Double = 0.10
    static let heroWashBaseBottom: Double = 0.30

    /// Alpha of a wash layer at translucency `t`. Scaling the wash with `t` is
    /// what lets the desktop through: a wash held near-constant (the old
    /// `washScale`) kept the pane ~86% opaque even at the glass end.
    static func washAlpha(base: Double, translucency: Double) -> Double {
        base * ScenerySettingsFile.clampTranslucency(translucency)
    }

    /// Opacity for the photo under a wash of `washAlpha`, such that the two
    /// together cover exactly `t`. Solving `wash + photo * (1 - wash) = t`.
    static func photoOpacity(translucency: Double, washAlpha wash: Double) -> Double {
        let t = ScenerySettingsFile.clampTranslucency(translucency)
        guard wash < 1 else { return 0 }
        return min(max((t - wash) / (1 - wash), 0), 1)
    }

    /// What a photo + wash pair actually covers — `t` by construction, and the
    /// number the probe checks against.
    static func coverage(photoOpacity photo: Double, washAlpha wash: Double) -> Double {
        wash + photo * (1 - wash)
    }

    /// Alpha of the flat window plate over the behind-window blur: `0` through
    /// the glass band, ramping to `1` (fully solid window) at `1.0`.
    static func windowPlate(translucency: Double) -> Double {
        let t = ScenerySettingsFile.clampTranslucency(translucency)
        let upper = ScenerySettingsFile.translucencyRange.upperBound
        guard t > plateStart else { return 0 }
        return min((t - plateStart) / (upper - plateStart), 1)
    }
}
