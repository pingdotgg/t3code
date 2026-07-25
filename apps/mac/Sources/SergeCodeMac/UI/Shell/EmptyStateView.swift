import SwiftUI

/// Empty-state hero shown as the detail column when no thread is selected:
/// full-bleed Dolomites scene (rotates daily) behind a welcome hub with the
/// brand, a time-aware greeting, and glass action cards, with the required
/// Unsplash attribution in the corner.
///
/// Arrival is a cascade: the glass card settles with the hero spring while the
/// brand, greeting, and action cards stagger in beneath it. The brand mark
/// then keeps a slow breathing float so the hub feels alive rather than
/// frozen; both the stagger and the float collapse to a plain fade under
/// Reduce Motion.
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
                    .welcomeFloat()
                BrandWordmark(size: 34)
                    .padding(.top, 16)
                    .entrance(.card, index: 1)
                Text(greeting)
                    .font(.title3.weight(.medium))
                    .foregroundStyle(.white.opacity(0.82))
                    .padding(.top, 5)
                    .entrance(.card, index: 2)
                Text("Select a session, start a quick chat, or choose a project.")
                    .font(SurgeTypography.agentStatus)
                    .foregroundStyle(.white.opacity(0.6))
                    .multilineTextAlignment(.center)
                    .padding(.top, 10)
                    .entrance(.card, index: 3)

                // .top alignment + a fixed card height keep the two tiles level
                // even though their detail lines wrap differently.
                HStack(alignment: .top, spacing: 12) {
                    WelcomeActionCard(
                        icon: "bubble.left.and.bubble.right",
                        title: "Quick Chat",
                        detail: "Jump into a general session — no project needed.",
                        tint: AlpineTheme.accent,
                        action: onQuickChat
                    )
                    .entrance(.card, index: 4)
                    .help("Start a general session in \(GeneralWorkspace.relativePath)")

                    WelcomeActionCard(
                        icon: "plus",
                        title: "New Session",
                        detail: "Pick a project and provider to work in.",
                        tint: AlpineTheme.sky,
                        action: onNewSession
                    )
                    .entrance(.card, index: 5)
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
                    .entrance(.control, index: 6)
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

/// Slow breathing drift for the welcome brand mark: a small vertical float
/// plus a soft sky glow that deepens at the top of the breath. Purely
/// decorative and render-only, so it never re-measures the hub. Reduce Motion
/// keeps the glow but drops the movement.
private struct WelcomeFloatModifier: ViewModifier {
    func body(content: Content) -> some View {
        if Motion.reduceMotion {
            content.shadow(color: AlpineTheme.sky.opacity(0.35), radius: 14, y: 5)
        } else {
            content.phaseAnimator([false, true]) { view, floating in
                view
                    .offset(y: floating ? -3.5 : 0)
                    .shadow(
                        color: AlpineTheme.sky.opacity(floating ? 0.5 : 0.28),
                        radius: floating ? 20 : 12,
                        y: floating ? 8 : 4)
            } animation: { _ in
                .easeInOut(duration: 1.8)
            }
        }
    }
}

extension View {
    fileprivate func welcomeFloat() -> some View {
        modifier(WelcomeFloatModifier())
    }
}

/// Glass action tile on the welcome hub: circular tinted glyph, title, and a
/// one-line description. Hover lifts the tile, brightens the glyph with a
/// tinted glow, and gives the symbol a one-shot bounce; press eases a small
/// scale — hover and lift through `Motion.feedback`, press through the card's
/// button style.
private struct WelcomeActionCard: View {
    let icon: String
    let title: String
    let detail: String
    let tint: Color
    let action: () -> Void

    @UIState private var isHovering = false
    @UIState private var hoverBeat = 0

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 8) {
                Image(systemName: icon)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(AlpineTheme.forest)
                    .frame(width: 38, height: 38)
                    .background(tint.opacity(isHovering ? 1 : 0.85), in: Circle())
                    .shadow(color: tint.opacity(isHovering ? 0.55 : 0), radius: 10)
                    // A beat per hover entry, not per hover exit, so the glyph
                    // only bounces as the pointer arrives.
                    .symbolEffect(.bounce, value: hoverBeat)

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
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(16)
            // Fixed height, not maxHeight: a Button sizes to its label instead
            // of stretching it, so sibling cards can only stay level if the
            // label itself pins the height. Sized for two detail lines.
            .frame(width: 190, height: 148, alignment: .topLeading)
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
        .offset(y: isHovering ? -3 : 0)
        .onHover { hovering in
            isHovering = hovering
            if hovering, !Motion.reduceMotion {
                hoverBeat += 1
            }
        }
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
