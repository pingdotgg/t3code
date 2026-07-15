import SwiftUI

/// Empty-state hero shown as the detail column when no thread is selected:
/// full-bleed Dolomites scene (rotates daily) under a glass card, with the
/// required Unsplash attribution in the corner.
struct EmptyStateView: View {
    let scenery: SceneryStore
    var onNewSession: () -> Void

    @UIState private var hasAppeared = false

    var body: some View {
        // dailyFeatured() reads rotationBucket/rotationDayKey via @Observable,
        // so a bucket/day change from App.onReceive reevaluates this body.
        let featured = scenery.dailyFeatured()
        let translucency = scenery.sceneryTranslucency
        let washTop = GlassLayering.washAlpha(
            base: GlassLayering.heroWashBaseTop, translucency: translucency)
        let washBottom = GlassLayering.washAlpha(
            base: GlassLayering.heroWashBaseBottom, translucency: translucency)
        ZStack {
            SceneryImageView(scenery: scenery, photo: featured, fallbackSeed: "empty-state")
                // Recreate the image subtree when the rotation seed changes so
                // a cached hero for the previous bucket cannot stick.
                .id(featured?.id ?? "empty-\(scenery.rotationDayKey)")
                // Photo and scrim both ride the translucency, so the hero
                // covers exactly as much desktop as the slider says.
                .opacity(
                    GlassLayering.photoOpacity(
                        translucency: translucency, washAlpha: washBottom))
                .overlay(
                    LinearGradient(
                        colors: [.black.opacity(washTop), .black.opacity(washBottom)],
                        startPoint: .top, endPoint: .bottom))
                .ignoresSafeArea()

            VStack(spacing: 16) {
                BrandMarkView()
                    .frame(width: 44, height: 44)
                BrandWordmark(size: 26)
                Text("Select a session, or start a new one.")
                    .foregroundStyle(.secondary)
                Button("New Session", action: onNewSession)
                    .buttonStyle(.glass)
                    .controlSize(.large)
            }
            .padding(32)
            .glassEffect(.regular, in: .rect(cornerRadius: AlpineTheme.Corners.hero))
            // Hero card settles into place on arrival instead of popping.
            .scaleEffect(hasAppeared ? 1.0 : 0.96)
            .opacity(hasAppeared ? 1.0 : 0.0)
            .animation(Motion.delight, value: hasAppeared)
            .onAppear { hasAppeared = true }
        }
        .overlay(alignment: .bottomTrailing) {
            if let featured {
                SceneryAttributionTag(photo: featured)
                    .padding(10)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
