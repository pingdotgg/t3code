import SwiftUI

/// Empty-state hero shown as the detail column when no thread is selected:
/// full-bleed Dolomites scene (rotates daily) behind a welcome hub with the
/// brand, a time-aware greeting, and glass action cards, with the required
/// Unsplash attribution in the corner.
struct EmptyStateView: View {
    let scenery: SceneryStore
    var onQuickChat: () -> Void
    var onNewSession: () -> Void

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
            SceneryImageView(
                scenery: scenery, photo: featured, fallbackSeed: "empty-state",
                // Keep sky/ridgeline when a wide window crops the scene.
                focal: .skyline)
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

            VStack(spacing: 0) {
                BrandMarkView(style: .fullColor)
                    .frame(width: 68, height: 68)
                BrandWordmark(size: 34)
                    .padding(.top, 16)
                Text(greeting)
                    .font(.title3.weight(.medium))
                    .foregroundStyle(.white.opacity(0.82))
                    .padding(.top, 5)
                Text("Select a session, start a quick chat, or choose a project.")
                    .font(SurgeTypography.agentStatus)
                    .foregroundStyle(.white.opacity(0.6))
                    .multilineTextAlignment(.center)
                    .padding(.top, 10)

                HStack(spacing: 12) {
                    WelcomeActionCard(
                        icon: "bubble.left.and.bubble.right",
                        title: "Quick Chat",
                        detail: "Jump into a general session — no project needed.",
                        tint: AlpineTheme.accent,
                        action: onQuickChat
                    )
                    .help("Start a general session in \(GeneralWorkspace.relativePath)")

                    WelcomeActionCard(
                        icon: "plus",
                        title: "New Session",
                        detail: "Pick a project and provider to work in.",
                        tint: AlpineTheme.sky,
                        action: onNewSession
                    )
                    .help("Choose a project and provider")
                }
                .padding(.top, 26)
            }
            .padding(.horizontal, 36)
            .padding(.vertical, 32)
            .glassEffect(.regular, in: .rect(cornerRadius: AlpineTheme.Corners.hero))
            .sceneryChrome()
            // Hero card settles into place on arrival instead of popping.
            .entrance(.hero)
        }
        .overlay(alignment: .bottomTrailing) {
            if let featured {
                SceneryAttributionTag(photo: featured)
                    .padding(10)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var greeting: String {
        switch Calendar.current.component(.hour, from: .now) {
        case 5..<12: "Good morning"
        case 12..<17: "Good afternoon"
        case 17..<22: "Good evening"
        default: "Good night"
        }
    }
}

/// Glass action tile on the welcome hub: circular tinted glyph, title, and a
/// one-line description. Hover lifts the fill and stroke; press eases a small
/// scale — both through `Motion.feedback`.
private struct WelcomeActionCard: View {
    let icon: String
    let title: String
    let detail: String
    let tint: Color
    let action: () -> Void

    @UIState private var isHovering = false

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 8) {
                Image(systemName: icon)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(AlpineTheme.forest)
                    .frame(width: 38, height: 38)
                    .background(tint.opacity(isHovering ? 1 : 0.85), in: Circle())

                Text(title)
                    .font(.headline)
                    .foregroundStyle(.white)
                    .padding(.top, 2)

                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.62))
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(width: 190, alignment: .leading)
            .padding(16)
            .contentShape(
                RoundedRectangle(
                    cornerRadius: AlpineTheme.Corners.hero, style: .continuous))
            .background {
                RoundedRectangle(
                    cornerRadius: AlpineTheme.Corners.hero, style: .continuous
                )
                .fill(Color.white.opacity(isHovering ? 0.12 : 0.07))
            }
            .overlay {
                RoundedRectangle(
                    cornerRadius: AlpineTheme.Corners.hero, style: .continuous
                )
                .stroke(
                    Color.white.opacity(isHovering ? 0.22 : 0.14), lineWidth: 1)
            }
        }
        .buttonStyle(WelcomeActionCardButtonStyle())
        .onHover { isHovering = $0 }
        .animation(Motion.feedback, value: isHovering)
    }
}

private struct WelcomeActionCardButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .opacity(configuration.isPressed ? 0.9 : 1)
            .animation(Motion.feedback, value: configuration.isPressed)
    }
}
