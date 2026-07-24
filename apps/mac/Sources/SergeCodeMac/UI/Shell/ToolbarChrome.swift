import SwiftUI

// MARK: - Toolbar chip chrome

/// Capsule glass chip for window-toolbar content, matching the circular
/// Liquid Glass controls it sits next to. Glass is intentional here: the
/// toolbar sits over scenery photos.
extension View {
    /// Capsule glass chip (height 28). When `interactive` is true, draws a
    /// hover wash animated with `Motion.feedback`.
    func alpineToolbarChip(interactive: Bool = false) -> some View {
        modifier(AlpineToolbarChipModifier(interactive: interactive))
    }
}

private struct AlpineToolbarChipModifier: ViewModifier {
    let interactive: Bool
    @UIState private var isHovering = false

    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 10)
            .frame(height: 28)
            .contentShape(Capsule())
            .background {
                if interactive, isHovering {
                    Capsule()
                        .fill(Color.primary.opacity(0.07))
                }
            }
            .glassEffect(.regular, in: Capsule())
            .onHover { hovering in
                guard interactive else { return }
                isHovering = hovering
            }
            .animation(Motion.feedback, value: isHovering)
    }
}

// MARK: - Icon button style

/// 28×28 circular glass icon button for the window toolbar (Inspector, New
/// Session split control).
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
            .contentShape(Circle())
            .background {
                let opacity: Double =
                    configuration.isPressed ? 0.11 : (isHovering ? 0.07 : 0)
                if opacity > 0 {
                    Circle()
                        .fill(Color.primary.opacity(opacity))
                }
            }
            .glassEffect(.regular, in: Circle())
            .opacity(isEnabled ? 1 : 0.4)
            .onHover { isHovering = $0 }
            .animation(Motion.feedback, value: isHovering)
            .animation(Motion.feedback, value: configuration.isPressed)
    }
}

// MARK: - New session split control

/// Two circular glass buttons: plus opens the full chooser directly, the
/// chevron presents a custom Alpine popover (never a native macOS menu) with
/// the quick same-project / other-provider shortcuts. The popover content
/// receives the presentation binding so rows can dismiss it.
struct NewSessionSplitControl<PopoverContent: View>: View {
    let onNewSession: () -> Void
    @ViewBuilder let popoverContent: (Binding<Bool>) -> PopoverContent

    @UIState private var isPresented = false

    var body: some View {
        HStack(spacing: 6) {
            Button(action: onNewSession) {
                Label("New Session", systemImage: "plus")
            }
            .buttonStyle(AlpineToolbarIconButtonStyle())
            .help("New Session")

            Button {
                isPresented.toggle()
            } label: {
                Label("New Session options", systemImage: "chevron.down")
                    .font(.system(size: 10, weight: .bold))
            }
            .buttonStyle(AlpineToolbarIconButtonStyle())
            .help("New Session options")
            .popover(isPresented: $isPresented, arrowEdge: .bottom) {
                popoverContent($isPresented)
            }
        }
    }
}
