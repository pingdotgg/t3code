import SwiftUI

// MARK: - Metrics

/// The one geometry every chip in the chat header's status bar is built from.
///
/// Before this existed each chip carried its own padding, corner radius, and
/// font: the branch trigger was a 8pt-radius rectangle with a 20pt icon tile
/// inside it, the working-tree counts were 8/4 capsules, the PR affordances
/// were 9/4.5 capsules, and merge was a 10/4 capsule with a shadow. Lined up
/// in a row they read as a pile of unrelated buttons at four different
/// heights. One height and one shape is what makes the bar read as a single
/// control instead.
enum HeaderChipMetrics {
    /// Every chip — readout, dropdown trigger, primary action — is exactly
    /// this tall. Sized so a `.caption` label clears its capsule comfortably
    /// while two rows of chips would still fit the 61pt header band.
    static let height: CGFloat = 26

    /// Horizontal padding inside a chip that carries text.
    static let horizontalPadding: CGFloat = 9

    /// Horizontal padding for an icon-only chip, so it comes out roughly
    /// square rather than a stretched pill.
    static let iconOnlyPadding: CGFloat = 7

    /// Gap between a chip's glyph and its text, and between adjacent runs of
    /// text inside one chip.
    static let contentSpacing: CGFloat = 5

    /// Gap between chips.
    static let barSpacing: CGFloat = 6

    static let font: Font = .caption.weight(.medium)
    static let iconFont: Font = .system(size: 10.5, weight: .semibold)
    static let chevronFont: Font = .system(size: 8, weight: .bold)
}

// MARK: - Roles

/// What a chip is, which decides its fill, its hairline, and its label color.
/// Four roles rather than per-chip colors: the bar has exactly four jobs to
/// communicate, and anything outside them would be a fifth visual language in
/// a row that is meant to read as one.
enum HeaderChipRole: Equatable {
    /// Non-interactive readout — working-tree counts, ahead/behind.
    case readout
    /// A readout or action that carries its own semantic tint: the PR link,
    /// unresolved comments, merge conflicts.
    case tinted(Color)
    /// Something the user presses or opens: the branch dropdown.
    case control
    /// The bar's primary actions — the git actions menu and merge.
    case primary
}

// MARK: - Chrome

/// The shared capsule chrome. Every chip in the bar goes through this exactly
/// once, so a change to the bar's look is a change in one place.
private struct HeaderChipChrome: ViewModifier {
    let role: HeaderChipRole
    /// The chip's popover is open (dropdown triggers only).
    let isOn: Bool
    let isHovering: Bool
    let isPressed: Bool
    /// Set only for chips whose label may be arbitrarily long (the branch
    /// name). Everything else is `fixedSize`d so a cramped header can never
    /// wrap "Conflicts" onto three lines the way it used to.
    let maxWidth: CGFloat?
    /// Icon-only chips get the tighter padding.
    let isIconOnly: Bool

    func body(content: Content) -> some View {
        sized(
            content
                .font(HeaderChipMetrics.font)
                .monospacedDigit()
                .lineLimit(1)
                .foregroundStyle(foreground)
                .padding(
                    .horizontal,
                    isIconOnly
                        ? HeaderChipMetrics.iconOnlyPadding
                        : HeaderChipMetrics.horizontalPadding)
                .frame(height: HeaderChipMetrics.height)
        )
        .contentShape(Capsule())
        .background {
            Capsule()
                .fill(fill)
                .overlay {
                    Capsule().strokeBorder(stroke, lineWidth: 1)
                }
        }
    }

    /// A chip either truncates within a cap or takes exactly the width its
    /// label needs. It never compresses: the header's row of chips is the one
    /// place in the app where SwiftUI's default "squeeze everything" behavior
    /// produced unreadable output.
    @ViewBuilder
    private func sized(_ content: some View) -> some View {
        if let maxWidth {
            content.frame(maxWidth: maxWidth, alignment: .leading)
        } else {
            content.fixedSize(horizontal: true, vertical: false)
        }
    }

    private var fill: Color {
        switch role {
        case .readout:
            Color.primary.opacity(0.05)
        case .tinted(let color):
            color.opacity(isPressed ? 0.24 : isHovering ? 0.18 : 0.12)
        case .control:
            Color.primary.opacity(isOn || isPressed ? 0.13 : isHovering ? 0.09 : 0.05)
        case .primary:
            AlpineTheme.accent.opacity(isOn || isPressed ? 0.62 : isHovering ? 0.5 : 0.34)
        }
    }

    private var stroke: Color {
        switch role {
        case .readout:
            Color.primary.opacity(0.09)
        case .tinted(let color):
            color.opacity(isHovering ? 0.38 : 0.26)
        case .control:
            Color.primary.opacity(isOn || isHovering ? 0.16 : 0.10)
        case .primary:
            AlpineTheme.accent.opacity(0.95)
        }
    }

    private var foreground: AnyShapeStyle {
        switch role {
        case .readout: AnyShapeStyle(.secondary)
        case .tinted(let color): AnyShapeStyle(color)
        case .control: AnyShapeStyle(.primary)
        case .primary: AnyShapeStyle(AlpineTheme.forest)
        }
    }
}

// MARK: - Chips

/// A non-interactive chip: working-tree counts, ahead/behind, anything the
/// bar states rather than offers.
struct HeaderChip<Label: View>: View {
    var role: HeaderChipRole = .readout
    var isIconOnly: Bool = false
    @ViewBuilder var label: Label

    var body: some View {
        label.modifier(
            HeaderChipChrome(
                role: role, isOn: false, isHovering: false, isPressed: false,
                maxWidth: nil, isIconOnly: isIconOnly))
    }
}

/// An interactive chip. Carries its own hover state (a `ButtonStyle` cannot
/// hold one) and, for dropdown triggers, the chevron that flips while the
/// popover is up.
struct HeaderChipButton<Label: View>: View {
    var role: HeaderChipRole = .control
    /// The chip's popover is presented.
    var isOn: Bool = false
    var maxWidth: CGFloat?
    var showsChevron: Bool = false
    var isIconOnly: Bool = false
    let action: () -> Void
    @ViewBuilder var label: Label

    @UIState private var isHovering = false
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Button(action: action) {
            HStack(spacing: HeaderChipMetrics.contentSpacing) {
                label
                if showsChevron {
                    Image(systemName: "chevron.down")
                        .font(HeaderChipMetrics.chevronFont)
                        .opacity(0.7)
                        .rotationEffect(.degrees(isOn ? 180 : 0))
                }
            }
        }
        .buttonStyle(
            HeaderChipButtonStyle(
                role: role, isOn: isOn, isHovering: isHovering, maxWidth: maxWidth,
                isIconOnly: isIconOnly))
        .opacity(isEnabled ? 1 : 0.45)
        .onHover { isHovering = $0 }
        .animation(Motion.feedback, value: isHovering)
        .animation(Motion.feedback, value: isOn)
    }
}

private struct HeaderChipButtonStyle: ButtonStyle {
    let role: HeaderChipRole
    let isOn: Bool
    let isHovering: Bool
    let maxWidth: CGFloat?
    let isIconOnly: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .modifier(
                HeaderChipChrome(
                    role: role, isOn: isOn, isHovering: isHovering,
                    isPressed: configuration.isPressed, maxWidth: maxWidth,
                    isIconOnly: isIconOnly))
            .pressFeedback(configuration.isPressed)
    }
}
