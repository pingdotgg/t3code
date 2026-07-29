import SwiftUI

// MARK: - Toolbar control groups

extension View {
    /// The low-contrast translucent surface shared by floating app controls.
    ///
    /// New Session established this treatment in the window toolbar. Reusing
    /// the same adaptive fill and hairline in the chat keeps repository,
    /// transcript, and progress controls on one visual plane without the
    /// heavier gray plates produced by system materials over scenery.
    func alpineGlassSurface<S: InsettableShape>(in shape: S) -> some View {
        background {
            shape.fill(Color.primary.opacity(0.055))
        }
        .overlay {
            shape.strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.5)
        }
        .clipShape(shape)
    }

    /// A quiet, connected surface for related window-toolbar content.
    func alpineToolbarControlGroup() -> some View {
        alpineGlassSurface(
            in:
            RoundedRectangle(
                cornerRadius: AlpineTheme.Corners.control, style: .continuous
            ))
    }
}

/// Hairline separator used inside a connected toolbar group.
struct AlpineToolbarDivider: View {
    var body: some View {
        Rectangle()
            .fill(Color.primary.opacity(0.1))
            .frame(width: 1, height: 14)
            .accessibilityHidden(true)
    }
}

// MARK: - Icon button style

/// 28×28 rounded-square icon button for the window toolbar.
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
            .font(.system(size: 12, weight: .medium))
            .frame(width: 28, height: 28)
            .contentShape(Rectangle())
            .background {
                let opacity: Double =
                    configuration.isPressed ? 0.14 : (isHovering ? 0.09 : 0.055)
                if opacity > 0 {
                    RoundedRectangle(
                        cornerRadius: AlpineTheme.Corners.control, style: .continuous
                    )
                        .fill(Color.primary.opacity(opacity))
                }
            }
            .overlay {
                RoundedRectangle(
                    cornerRadius: AlpineTheme.Corners.control, style: .continuous
                )
                .strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.5)
            }
            .opacity(isEnabled ? 1 : 0.4)
            .onHover { isHovering = $0 }
            .animation(Motion.feedback, value: isHovering)
            .animation(Motion.feedback, value: configuration.isPressed)
            .hapticPress(configuration.isPressed)
    }
}

/// Flat toolbar segment used by the connected New Session split control.
private struct AlpineToolbarSegmentButtonStyle: ButtonStyle {
    let horizontalPadding: CGFloat

    func makeBody(configuration: Configuration) -> some View {
        AlpineToolbarSegmentButtonBody(
            configuration: configuration,
            horizontalPadding: horizontalPadding)
    }
}

private struct AlpineToolbarSegmentButtonBody: View {
    let configuration: ButtonStyle.Configuration
    let horizontalPadding: CGFloat

    @UIState private var isHovering = false
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        configuration.label
            .font(.system(size: 12, weight: .medium))
            .padding(.horizontal, horizontalPadding)
            .frame(height: 28)
            .contentShape(Rectangle())
            .background {
                let opacity: Double =
                    configuration.isPressed ? 0.14 : (isHovering ? 0.09 : 0)
                if opacity > 0 {
                    Rectangle()
                        .fill(Color.primary.opacity(opacity))
                }
            }
            .opacity(isEnabled ? 1 : 0.4)
            .onHover { isHovering = $0 }
            .animation(Motion.feedback, value: isHovering)
            .animation(Motion.feedback, value: configuration.isPressed)
            .hapticPress(configuration.isPressed)
    }
}

// MARK: - New session split control

/// A connected, labeled split button. The primary segment opens the full
/// chooser; the chevron presents a custom Alpine popover (never a native
/// macOS menu) with quick same-project / other-provider shortcuts.
struct NewSessionSplitControl<PopoverContent: View>: View {
    let onNewSession: () -> Void
    @ViewBuilder let popoverContent: (Binding<Bool>) -> PopoverContent

    @UIState private var isPresented = false

    var body: some View {
        HStack(spacing: 0) {
            Button(action: onNewSession) {
                HStack(spacing: 6) {
                    Image(systemName: "plus")
                    Text("New Session")
                }
            }
            .buttonStyle(AlpineToolbarSegmentButtonStyle(horizontalPadding: 9))
            .help("New Session")
            .accessibilityLabel("New Session")

            AlpineToolbarDivider()

            Button {
                isPresented.toggle()
            } label: {
                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .bold))
            }
            .buttonStyle(AlpineToolbarSegmentButtonStyle(horizontalPadding: 8))
            .help("New Session options")
            .accessibilityLabel("New Session options")
            .popover(isPresented: $isPresented, arrowEdge: .bottom) {
                popoverContent($isPresented)
            }
        }
        .alpineToolbarControlGroup()
    }
}
