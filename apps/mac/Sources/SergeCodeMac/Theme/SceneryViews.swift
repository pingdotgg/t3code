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
        .animation(Motion.scenery, value: loadedPhotoID)
        .clipped()
        // Flatten the wash + photo before any caller applies `.opacity`:
        // SwiftUI fades each leaf separately otherwise, so the two opaque
        // layers stack and the pane covers more of the desktop than the
        // requested translucency (measurably: 0.67 instead of 0.50).
        .compositingGroup()
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
/// Renders at full coverage, unlike the chat wallpaper: its only surface is a
/// preview band inside the New Session sheet, and a sheet is an opaque window
/// — fading the photo there would dim it against the sheet's own plate rather
/// than reveal anything behind the app.
struct FrostedSceneryBackdrop: View {
    let scenery: SceneryStore
    let photo: SceneryPhoto?
    var setId: String?
    var fallbackSeed: String = "sergecode"
    /// Frost strength; lower shows more of the scene.
    /// The compatibility value of 9 maps to the pre-blurred chrome variant.
    var blurRadius: CGFloat = 9

    var body: some View {
        SceneryImageView(
            scenery: scenery,
            photo: photo,
            variant: preblurredVariant,
            setId: setId,
            fallbackSeed: fallbackSeed)
            .overlay(
                LinearGradient(
                    colors: [.black.opacity(0.34), .black.opacity(0.18)],
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
/// This is the surface the translucency invariant is defined on: photo + wash
/// composite to exactly `scenery.sceneryTranslucency`, so at the default 0.85
/// the desktop reads faintly through the scene and at 0.5 it reads clearly
/// (see `GlassLayering`). The photo, not the wash, absorbs the difference —
/// scaling only the photo (the old behaviour) left the pane ~86% opaque even
/// at the glass end, which is the layering bug this fixes.
struct SceneryChatBackground: View {
    let scenery: SceneryStore
    let photo: SceneryPhoto?
    var setId: String?
    var fallbackSeed: String = "sergecode"

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let translucency = scenery.sceneryTranslucency
        let wash = GlassLayering.washAlpha(
            base: GlassLayering.chatWashBase(colorScheme), translucency: translucency)
        SceneryImageView(
            scenery: scenery,
            photo: photo,
            variant: .heroBlurChat,
            setId: setId,
            fallbackSeed: fallbackSeed)
            .opacity(
                GlassLayering.photoOpacity(translucency: translucency, washAlpha: wash))
            .overlay(
                colorScheme == .dark
                    ? Color.black.opacity(wash)
                    : Color.white.opacity(wash))
            // Slightly heavier at the top so header text always clears the
            // brightest part of a sky. Edge tint only — it rides the same
            // translucency so it can't reintroduce an opaque pane.
            .overlay(
                LinearGradient(
                    colors: [
                        washEdge.opacity(0.35 * translucency), .clear, .clear,
                        washEdge.opacity(0.25 * translucency),
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
