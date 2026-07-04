import SwiftUI

/// A scenery photo (or its gradient fallback) as a fill. Always renders the
/// deterministic alpine wash immediately; the photo cross-fades in when the
/// store has it decoded.
struct SceneryImageView: View {
    let scenery: SceneryStore
    let photo: SceneryPhoto?
    var variant: SceneryStore.ImageVariant = .hero
    /// Seed for the gradient fallback when there is no photo (keyless /
    /// offline); defaults to the photo id.
    var fallbackSeed: String = "sergecode"

    var body: some View {
        ZStack {
            AlpineTheme.gradient(seed: photo?.id ?? fallbackSeed)
            if let photo, let image = scenery.image(photo, variant: variant) {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFill()
                    .transition(.opacity)
            }
        }
        .animation(.easeIn(duration: 0.35), value: loadedPhotoID)
        .clipped()
        .task(id: taskKey) {
            await scenery.ensureImage(photo, variant: variant)
        }
    }

    private var loadedPhotoID: String? {
        guard let photo, scenery.image(photo, variant: variant) != nil else { return nil }
        return photo.id
    }

    private var taskKey: String {
        "\(photo?.id ?? "-")/\(variant.rawValue)"
    }
}

/// Frosted scenery band for chrome surfaces (headers, sheet strips): photo
/// with an explicit gaussian frost and a top-down scrim so short chrome text
/// stays legible. Deliberately NOT a SwiftUI `Material` — materials sample
/// the backdrop behind them (near-opaque gray on macOS), hiding the photo
/// entirely. Pair with `.sceneryChrome()` on the foreground content. Long-form
/// text never sits on this (Liquid Glass rule).
struct FrostedSceneryBackdrop: View {
    let scenery: SceneryStore
    let photo: SceneryPhoto?
    var fallbackSeed: String = "sergecode"
    /// Frost strength; lower shows more of the scene.
    var blurRadius: CGFloat = 9

    var body: some View {
        SceneryImageView(scenery: scenery, photo: photo, fallbackSeed: fallbackSeed)
            .blur(radius: blurRadius, opaque: true)
            .saturation(1.08)
            .overlay(
                LinearGradient(
                    colors: [.black.opacity(0.34), .black.opacity(0.18)],
                    startPoint: .top, endPoint: .bottom))
            .clipped()
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
struct SceneryChatBackground: View {
    let scenery: SceneryStore
    let photo: SceneryPhoto?
    var fallbackSeed: String = "sergecode"

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        SceneryImageView(scenery: scenery, photo: photo, fallbackSeed: fallbackSeed)
            .blur(radius: 4, opaque: true)
            .saturation(1.05)
            .overlay(colorScheme == .dark ? Color.black.opacity(0.50) : .white.opacity(0.58))
            // Slightly heavier at the top so header text always clears the
            // brightest part of a sky.
            .overlay(
                LinearGradient(
                    colors: [
                        washEdge.opacity(0.35), .clear, .clear, washEdge.opacity(0.25),
                    ],
                    startPoint: .top, endPoint: .bottom))
            .clipped()
            .ignoresSafeArea()
    }

    private var washEdge: Color {
        colorScheme == .dark ? .black : .white
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
