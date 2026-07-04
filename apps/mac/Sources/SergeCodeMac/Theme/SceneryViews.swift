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

/// Heavily frosted scenery band for chrome surfaces (headers, sheet strips):
/// photo, material blur, and a top-down scrim so short chrome text stays
/// legible. Long-form text never sits on this (Liquid Glass rule).
struct FrostedSceneryBackdrop: View {
    let scenery: SceneryStore
    let photo: SceneryPhoto?
    var fallbackSeed: String = "sergecode"

    var body: some View {
        SceneryImageView(scenery: scenery, photo: photo, fallbackSeed: fallbackSeed)
            .overlay(.ultraThinMaterial)
            .overlay(
                LinearGradient(
                    colors: [.black.opacity(0.16), .black.opacity(0.04)],
                    startPoint: .top, endPoint: .bottom))
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
        .background(.ultraThinMaterial, in: Capsule())
    }

    private var profileURL: URL? {
        photo.photographerProfileURL.flatMap {
            URL(string: $0.absoluteString + Self.utm)
        }
    }
}
