import SwiftUI

/// Empty-state hero shown as the detail column when no thread is selected:
/// full-bleed Dolomites scene (rotates daily) under a glass card, with the
/// required Unsplash attribution in the corner.
struct EmptyStateView: View {
    let scenery: SceneryStore
    var onNewSession: () -> Void

    @UIState private var hasAppeared = false

    var body: some View {
        let featured = scenery.dailyFeatured()
        ZStack {
            SceneryImageView(scenery: scenery, photo: featured, fallbackSeed: "empty-state")
                .overlay(
                    LinearGradient(
                        colors: [.black.opacity(0.10), .black.opacity(0.30)],
                        startPoint: .top, endPoint: .bottom))
                .ignoresSafeArea()

            VStack(spacing: 16) {
                Image(systemName: "mountain.2.fill")
                    .font(.system(size: 44))
                    .foregroundStyle(.tint)
                Text("SergeCode")
                    .font(.largeTitle.bold())
                Text("Select a session, or start a new one.")
                    .foregroundStyle(.secondary)
                Button("New Session", action: onNewSession)
                    .buttonStyle(.glass)
                    .controlSize(.large)
            }
            .padding(32)
            .glassEffect(.regular, in: .rect(cornerRadius: 24))
            // Hero card settles into place on arrival instead of popping.
            .scaleEffect(hasAppeared ? 1.0 : 0.96)
            .opacity(hasAppeared ? 1.0 : 0.0)
            .animation(Motion.enter, value: hasAppeared)
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
