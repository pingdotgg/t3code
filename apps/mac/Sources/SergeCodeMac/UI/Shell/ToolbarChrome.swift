import SwiftUI

// MARK: - Toolbar chip chrome

/// App-shaped glass chip for window-toolbar content. Replaces the over-rounded
/// system Liquid Glass capsule after `.sharedBackgroundVisibility(.hidden)`.
/// Glass is intentional here: toolbar sits over scenery photos.
extension View {
    /// Squared continuous glass chip (height 28). When `interactive` is true,
    /// draws a hover wash animated with `Motion.feedback`.
    func alpineToolbarChip(interactive: Bool = false) -> some View {
        modifier(AlpineToolbarChipModifier(interactive: interactive))
    }
}

private struct AlpineToolbarChipModifier: ViewModifier {
    let interactive: Bool
    @UIState private var isHovering = false

    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 9)
            .frame(height: 28)
            .contentShape(
                RoundedRectangle(
                    cornerRadius: AlpineTheme.Corners.control, style: .continuous))
            .background {
                if interactive, isHovering {
                    RoundedRectangle(
                        cornerRadius: AlpineTheme.Corners.control, style: .continuous
                    )
                    .fill(Color.primary.opacity(0.07))
                }
            }
            .glassEffect(
                .regular,
                in: .rect(cornerRadius: AlpineTheme.Corners.control, style: .continuous)
            )
            .onHover { hovering in
                guard interactive else { return }
                isHovering = hovering
            }
            .animation(Motion.feedback, value: isHovering)
    }
}

// MARK: - Icon button style

/// 28×28 glass icon chip for toolbar icon buttons (Inspector).
struct AlpineToolbarIconButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        AlpineToolbarIconButtonBody(configuration: configuration)
    }
}

private struct AlpineToolbarIconButtonBody: View {
    let configuration: ButtonStyle.Configuration
    @UIState private var isHovering = false
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        configuration.label
            .labelStyle(.iconOnly)
            .frame(width: 28, height: 28)
            .contentShape(
                RoundedRectangle(
                    cornerRadius: AlpineTheme.Corners.control, style: .continuous))
            .background {
                let opacity: Double =
                    configuration.isPressed ? 0.11 : (isHovering ? 0.07 : 0)
                if opacity > 0 {
                    RoundedRectangle(
                        cornerRadius: AlpineTheme.Corners.control, style: .continuous
                    )
                    .fill(Color.primary.opacity(opacity))
                }
            }
            .glassEffect(
                .regular,
                in: .rect(cornerRadius: AlpineTheme.Corners.control, style: .continuous)
            )
            .opacity(isEnabled ? 1 : 0.4)
            .onHover { isHovering = $0 }
            .animation(Motion.feedback, value: isHovering)
            .animation(Motion.feedback, value: configuration.isPressed)
    }
}

// MARK: - New session split control

/// Plus button + disclosure chevron sharing one squared glass chip. Primary
/// click on plus opens the full chooser; the chevron menu keeps the quick
/// same-project / other-provider shortcuts.
struct NewSessionSplitControl<MenuContent: View>: View {
    let onNewSession: () -> Void
    @ViewBuilder let menuContent: () -> MenuContent

    @UIState private var plusHovering = false
    @UIState private var chevronHovering = false

    var body: some View {
        HStack(spacing: 0) {
            Button(action: onNewSession) {
                Image(systemName: "plus")
                    .font(.system(size: 13, weight: .semibold))
                    .frame(width: 26, height: 26)
                    .contentShape(Rectangle())
                    .background {
                        if plusHovering {
                            RoundedRectangle(
                                cornerRadius: AlpineTheme.Corners.compact,
                                style: .continuous
                            )
                            .fill(Color.primary.opacity(0.07))
                        }
                    }
            }
            .buttonStyle(.plain)
            .help("New Session")
            .accessibilityLabel("New Session")
            .onHover { plusHovering = $0 }

            Rectangle()
                .fill(.separator)
                .frame(width: 1, height: 14)
                .padding(.horizontal, 1)

            // `.menuStyle(.button)` + plain button style aims to drop the
            // system Menu bezel so only our glass chip frames the chevron.
            // If a bezel reappears under a future SDK, fall back to
            // Button + `.popover` (see `RunProfileMenu`).
            Menu {
                menuContent()
            } label: {
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .bold))
                    .frame(width: 22, height: 26)
                    .contentShape(Rectangle())
                    .background {
                        if chevronHovering {
                            RoundedRectangle(
                                cornerRadius: AlpineTheme.Corners.compact,
                                style: .continuous
                            )
                            .fill(Color.primary.opacity(0.07))
                        }
                    }
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .help("New Session options")
            .accessibilityLabel("New Session options")
            .onHover { chevronHovering = $0 }
        }
        .padding(.horizontal, 3)
        .frame(height: 28)
        .glassEffect(
            .regular,
            in: .rect(cornerRadius: AlpineTheme.Corners.control, style: .continuous)
        )
        .animation(Motion.feedback, value: plusHovering)
        .animation(Motion.feedback, value: chevronHovering)
    }
}
