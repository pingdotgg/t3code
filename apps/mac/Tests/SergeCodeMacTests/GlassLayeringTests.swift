import SwiftUI
import Testing

@testable import SergeCodeMac

@Suite("Glass layering")
struct GlassLayeringTests {
    /// The whole point of the model: what the app paints behind chat content
    /// covers exactly the requested translucency, so `1 - t` of the desktop
    /// reaches the user. `UIProbeGlass` measures the same number on the real
    /// window (0.502 / 0.651 / 0.847 / 1.000 for the stops below).
    @Test("photo + wash cover exactly the requested translucency", arguments: [
        0.5, 0.65, 0.75, 0.85, 1.0,
    ])
    func coverageMatchesTranslucency(_ t: Double) {
        for scheme in [ColorScheme.dark, .light] {
            let wash = GlassLayering.washAlpha(
                base: GlassLayering.chatWashBase(scheme), translucency: t)
            let photo = GlassLayering.photoOpacity(translucency: t, washAlpha: wash)
            let coverage = GlassLayering.coverage(photoOpacity: photo, washAlpha: wash)
            #expect(abs(coverage - t) < 0.0001)
        }
    }

    @Test("photo carries the scene at full opacity only when the window is solid")
    func photoOpacityRange() {
        let dark = GlassLayering.chatWashBase(.dark)
        let solidWash = GlassLayering.washAlpha(base: dark, translucency: 1.0)
        #expect(
            GlassLayering.photoOpacity(translucency: 1.0, washAlpha: solidWash) == 1.0)

        // At the glass end the image is still clearly present, just not a
        // plate: "slightly opaque location image".
        let glassWash = GlassLayering.washAlpha(base: dark, translucency: 0.5)
        let glassPhoto = GlassLayering.photoOpacity(translucency: 0.5, washAlpha: glassWash)
        #expect(glassPhoto > 0.25)
        #expect(glassPhoto < 0.45)
    }

    @Test("wash and photo both fade as the window turns to glass")
    func layersDecreaseMonotonically() {
        let stops = [1.0, 0.9, 0.8, 0.7, 0.6, 0.5]
        let washes = stops.map {
            GlassLayering.washAlpha(base: GlassLayering.chatWashBase(.dark), translucency: $0)
        }
        let photos = zip(stops, washes).map {
            GlassLayering.photoOpacity(translucency: $0, washAlpha: $1)
        }
        #expect(washes == washes.sorted(by: >))
        #expect(photos == photos.sorted(by: >))
    }

    @Test("out-of-range translucency clamps instead of over/under-covering")
    func clamping() {
        let low = GlassLayering.washAlpha(base: 0.5, translucency: -1)
        let floorWash = GlassLayering.washAlpha(
            base: 0.5, translucency: ScenerySettingsFile.translucencyRange.lowerBound)
        #expect(low == floorWash)
        #expect(GlassLayering.photoOpacity(translucency: 2, washAlpha: 0) == 1.0)
        #expect(GlassLayering.photoOpacity(translucency: 0.8, washAlpha: 1.0) == 0)
    }

    /// The window plate sits under the scenery as well as under the chrome, so
    /// any alpha it spends is alpha the desktop can never reach. It must stay
    /// at zero through the glass band and only close the window at the top.
    @Test("window plate is zero through the glass band and solid at 1.0")
    func windowPlate() {
        #expect(GlassLayering.windowPlate(translucency: 0.5) == 0)
        #expect(GlassLayering.windowPlate(translucency: 0.75) == 0)
        #expect(GlassLayering.windowPlate(translucency: GlassLayering.plateStart) == 0)
        #expect(GlassLayering.windowPlate(translucency: 1.0) == 1.0)

        let mid = GlassLayering.windowPlate(translucency: 0.925)
        #expect(mid > 0.4 && mid < 0.6)
    }

    @Test("plate ramp starts at the default translucency")
    func plateStartsAtDefault() {
        #expect(GlassLayering.plateStart == ScenerySettingsFile.defaultTranslucency)
    }
}
