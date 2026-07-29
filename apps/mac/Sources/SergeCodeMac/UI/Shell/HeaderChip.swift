import SwiftUI

// MARK: - Metrics

/// The one geometry every segment in the chat header's repository bar is built from.
///
/// The outer bar owns the material, border, and rounded silhouette. Individual
/// segments only own their content and interaction state, so repository updates
/// never create a row of unrelated floating pills.
enum HeaderChipMetrics {
    /// Every segment — readout, dropdown trigger, primary action — is exactly
    /// this tall. Sized so a `.caption` label clears its segment comfortably
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

    /// A one-point seam is enough to separate adjacent segments while keeping
    /// the controls visibly joined.
    static let barSpacing: CGFloat = 1
    static let barInset: CGFloat = 1
    static let barCornerRadius: CGFloat = 8

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

/// The shared segment chrome. The containing bar owns the silhouette; every
/// segment goes through this exactly once for sizing and interaction feedback.
private struct HeaderChipChrome: ViewModifier {
    let role: HeaderChipRole
    /// The chip's popover is open (dropdown triggers only).
    let isOn: Bool
    let isHovering: Bool
    let isPressed: Bool
    /// Exact slot width at the active density tier.
    let width: CGFloat?
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
        .contentShape(Rectangle())
        .background {
            Rectangle().fill(fill)
        }
    }

    /// Stable segments take an exact width; uncapped content takes its ideal
    /// width. Exact widths are what keep branch, status, PR, and action changes
    /// from moving the controls around.
    @ViewBuilder
    private func sized(_ content: some View) -> some View {
        if let width {
            content.frame(width: width, alignment: .leading)
        } else {
            content.fixedSize(horizontal: true, vertical: false)
        }
    }

    private var fill: Color {
        switch role {
        case .readout:
            .clear
        case .tinted(let color):
            color.opacity(isPressed ? 0.18 : isHovering ? 0.12 : 0.07)
        case .control:
            Color.primary.opacity(isOn || isPressed ? 0.11 : isHovering ? 0.07 : 0)
        case .primary:
            AlpineTheme.accent.opacity(isOn || isPressed ? 0.46 : isHovering ? 0.36 : 0.25)
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

// MARK: - Unified bar

extension View {
    /// One quiet translucent surface around the whole repository control. The
    /// one-point HStack gaps reveal it as internal separators.
    func headerControlBarChrome() -> some View {
        padding(HeaderChipMetrics.barInset)
            .alpineGlassSurface(
                in:
                RoundedRectangle(
                    cornerRadius: HeaderChipMetrics.barCornerRadius, style: .continuous))
    }
}

// MARK: - Chips

/// A non-interactive chip: working-tree counts, ahead/behind, anything the
/// bar states rather than offers.
struct HeaderChip<Label: View>: View {
    var role: HeaderChipRole = .readout
    /// Exact slot width. Left nil, the segment takes its ideal width.
    var width: CGFloat?
    var isIconOnly: Bool = false
    @ViewBuilder var label: Label

    var body: some View {
        label.modifier(
            HeaderChipChrome(
                role: role, isOn: false, isHovering: false, isPressed: false,
                width: width, isIconOnly: isIconOnly))
    }
}

/// An interactive chip. Carries its own hover state (a `ButtonStyle` cannot
/// hold one) and, for dropdown triggers, the chevron that flips while the
/// popover is up.
struct HeaderChipButton<Label: View>: View {
    var role: HeaderChipRole = .control
    /// The chip's popover is presented.
    var isOn: Bool = false
    var width: CGFloat?
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
                role: role, isOn: isOn, isHovering: isHovering, width: width,
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
    let width: CGFloat?
    let isIconOnly: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .modifier(
                HeaderChipChrome(
                    role: role, isOn: isOn, isHovering: isHovering,
                    isPressed: configuration.isPressed, width: width,
                    isIconOnly: isIconOnly))
            .pressFeedback(configuration.isPressed)
    }
}
