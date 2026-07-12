import SwiftUI

/// A scenery photo (or its gradient fallback) as a fill. Always renders the
/// deterministic alpine wash immediately; the photo cross-fades in when the
/// store has it decoded.
struct SceneryImageView: View {
    let scenery: SceneryStore
    let photo: SceneryPhoto?
    var variant: SceneryStore.ImageVariant = .hero
    var setId: String?
    /// Seed for the gradient fallback when there is no photo (keyless /
    /// offline); defaults to the photo id.
    var fallbackSeed: String = "sergecode"

    var body: some View {
        ZStack {
            AlpineTheme.gradient(
                seed: photo?.id ?? fallbackSeed,
                palette: scenery.palette(for: photo, setId: setId))
            if let photo, let image = scenery.image(photo, variant: variant, setId: setId) {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFill()
                    .transition(.opacity)
                    // Identity keyed to the photo so swapping scenes (thread
                    // switch) cross-fades old → new instead of hard-cutting.
                    .id(loadedPhotoID)
            }
        }
        .animation(.easeInOut(duration: 0.45), value: loadedPhotoID)
        .clipped()
        .task(id: taskKey) {
            await scenery.ensureImage(photo, variant: variant, setId: setId)
        }
    }

    private var loadedPhotoID: String? {
        guard let photo, scenery.image(photo, variant: variant, setId: setId) != nil else {
            return nil
        }
        return photo.id
    }

    private var taskKey: String {
        "\(setId ?? "-")/\(photo?.id ?? "-")/\(variant.rawValue)"
    }
}

/// Frosted scenery band for chrome surfaces (headers, sheet strips): photo
/// with an explicit gaussian frost and a top-down scrim so short chrome text
/// stays legible. Deliberately NOT a SwiftUI `Material` — materials sample
/// the backdrop behind them (near-opaque gray on macOS), hiding the photo
/// entirely. Pair with `.sceneryChrome()` on the foreground content. Long-form
/// text never sits on this (Liquid Glass rule).
///
/// Photo opacity follows `scenery.sceneryTranslucency` so the window's
/// behind-window glass (`WindowGlassBackground`) can bleed through; the
/// scrim is scaled gently so chrome labels stay readable at the 50% extreme.
struct FrostedSceneryBackdrop: View {
    let scenery: SceneryStore
    let photo: SceneryPhoto?
    var setId: String?
    var fallbackSeed: String = "sergecode"
    /// Frost strength; lower shows more of the scene.
    /// The compatibility value of 9 maps to the pre-blurred chrome variant.
    var blurRadius: CGFloat = 9

    var body: some View {
        let translucency = scenery.sceneryTranslucency
        let wash = ScenerySettingsFile.washScale(forTranslucency: translucency)
        SceneryImageView(
            scenery: scenery,
            photo: photo,
            variant: preblurredVariant,
            setId: setId,
            fallbackSeed: fallbackSeed)
            // Fade photo only — scrim stays above so chrome stays legible.
            .opacity(translucency)
            .overlay(
                LinearGradient(
                    colors: [
                        .black.opacity(0.34 * wash),
                        .black.opacity(0.18 * wash),
                    ],
                    startPoint: .top, endPoint: .bottom))
            .clipped()
    }

    private var preblurredVariant: SceneryStore.ImageVariant {
        // If an older caller supplies a non-default value, choose the nearest
        // of the two baked radii (4 and 9); current call sites use 9.
        blurRadius <= 6.5 ? .heroBlurChat : .heroBlurChrome
    }
}

extension View {
    /// Foreground treatment for content sitting on `FrostedSceneryBackdrop`:
    /// render as dark-mode (white text/symbols) regardless of the app
    /// appearance, since the scrimmed photo is always dark.
    func sceneryChrome() -> some View {
        environment(\.colorScheme, .dark)
    }
}

/// Full-bleed chat wallpaper: the thread's scene, lightly frosted, under a
/// window-tone wash. The wash is the legibility system — it pulls the photo
/// toward the appearance's background tone (black-ish in dark mode, white-ish
/// in light) far enough that standard `.primary`/`.secondary` text stays
/// readable everywhere on top, while the scene stays clearly visible.
///
/// Photo opacity is `scenery.sceneryTranslucency` (default 0.85) so the
/// behind-window glass underneath shows through. Wash layers sit above the
/// opacity and are only gently scaled — they must not collapse with the
/// photo at 50% translucency.
struct SceneryChatBackground: View {
    let scenery: SceneryStore
    let photo: SceneryPhoto?
    var setId: String?
    var fallbackSeed: String = "sergecode"

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let translucency = scenery.sceneryTranslucency
        let wash = ScenerySettingsFile.washScale(forTranslucency: translucency)
        SceneryImageView(
            scenery: scenery,
            photo: photo,
            variant: .heroBlurChat,
            setId: setId,
            fallbackSeed: fallbackSeed)
            // Fade photo/gradient only; wash overlays stay above for contrast.
            .opacity(translucency)
            .overlay(
                colorScheme == .dark
                    ? Color.black.opacity(0.50 * wash)
                    : Color.white.opacity(0.58 * wash))
            // Slightly heavier at the top so header text always clears the
            // brightest part of a sky.
            .overlay(
                LinearGradient(
                    colors: [
                        washEdge.opacity(0.35 * wash), .clear, .clear,
                        washEdge.opacity(0.25 * wash),
                    ],
                    startPoint: .top, endPoint: .bottom))
            .clipped()
            .ignoresSafeArea()
    }

    private var washEdge: Color {
        AlpineTheme.sceneryWash(
            seed: photo?.id ?? fallbackSeed,
            palette: scenery.palette(for: photo, setId: setId),
            colorScheme: colorScheme)
    }
}

/// "Photo by NAME on Unsplash" — required attribution, with the UTM
/// parameters the Unsplash guidelines specify. Render wherever a photo is
/// shown prominently.
struct SceneryAttributionTag: View {
    let photo: SceneryPhoto

    private static let utm = "?utm_source=\(UnsplashClient.appName)&utm_medium=referral"

    var body: some View {
        HStack(spacing: 3) {
            Text("Photo by")
            if let profile = profileURL {
                Link(photo.photographerName, destination: profile)
            } else {
                Text(photo.photographerName)
            }
            Text("on")
            Link("Unsplash", destination: URL(string: "https://unsplash.com\(Self.utm)")!)
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        // Solid translucent pill, not a material — see FrostedSceneryBackdrop.
        .background(Color.black.opacity(0.32), in: Capsule())
        .sceneryChrome()
    }

    private var profileURL: URL? {
        photo.photographerProfileURL.flatMap {
            URL(string: $0.absoluteString + Self.utm)
        }
    }
}
