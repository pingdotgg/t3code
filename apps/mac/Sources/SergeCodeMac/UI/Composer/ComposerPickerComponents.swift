import SwiftUI

/// Shared presentation chrome for composer pickers. The closed controls and
/// their opened surfaces should read as one system, rather than dropping into
/// the standard macOS menu appearance after the click.
struct ComposerPickerSurface<Content: View>: View {
    let width: CGFloat
    var height: CGFloat?
    @ViewBuilder let content: Content

    init(
        width: CGFloat,
        height: CGFloat? = nil,
        @ViewBuilder content: () -> Content
    ) {
        self.width = width
        self.height = height
        self.content = content()
    }

    var body: some View {
        content
            .frame(width: width)
            .frame(height: height)
            .background {
                ZStack {
                    Rectangle().fill(.ultraThinMaterial)
                    LinearGradient(
                        colors: [
                            AlpineTheme.accent.opacity(0.075),
                            Color.clear,
                            AlpineTheme.sky.opacity(0.045),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                }
            }
    }
}
struct ComposerPickerHeader: View {
    let icon: String
    let title: String
    let subtitle: String
    /// When set, shows a leading chevron that navigates back within a multi-page popover.
    var onBack: (() -> Void)? = nil
    /// Headers that title themselves after user content (a thread title, a
    /// branch) cap the line count; the fixed-label pickers leave this nil and
    /// keep wrapping.
    var titleLineLimit: Int? = nil

    var body: some View {
        HStack(spacing: 10) {
            if let onBack {
                Button(action: onBack) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Back")
            }

            Image(systemName: icon)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(AlpineTheme.forest)
                .frame(width: 30, height: 30)
                .background(AlpineTheme.accent.opacity(0.9), in: RoundedRectangle(
                    cornerRadius: AlpineTheme.Corners.control,
                    style: .continuous
                ))

            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.headline)
                    .lineLimit(titleLineLimit)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.top, 13)
        .padding(.bottom, 11)
    }
}

struct ComposerPickerSectionLabel: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 6)
            .padding(.top, 5)
            .padding(.bottom, 2)
    }
}

struct ComposerPickerChoiceRow: View {
    let icon: String?
    let title: String
    var detail: String?
    let isSelected: Bool
    /// Per-choice accent (effort level / mode colors). Nil keeps the shared
    /// meadow accent so plain pickers are unchanged.
    var tint: Color? = nil
    let action: () -> Void

    @UIState private var isHovering = false

    private var accent: Color { tint ?? AlpineTheme.accent }

    var body: some View {
        Button {
            // Re-picking the active choice is a no-op for the backend but
            // still a real click, so it ticks either way.
            Haptics.play(.selection)
            action()
        } label: {
            HStack(spacing: 10) {
                if let icon {
                    Image(systemName: icon)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(isSelected ? AlpineTheme.forest : Color.secondary)
                        .frame(width: 28, height: 28)
                        .background(
                            isSelected ? accent.opacity(0.85) : Color.secondary.opacity(0.09),
                            in: RoundedRectangle(cornerRadius: 7, style: .continuous)
                        )
                }

                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(.callout.weight(.medium))
                        .foregroundStyle(.primary)
                    if let detail {
                        Text(detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }

                Spacer(minLength: 8)

                Image(systemName: "checkmark")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(AlpineTheme.forest)
                    .frame(width: 22, height: 22)
                    .background(accent, in: Circle())
                    // Zero opacity keeps the layout stable but leaves the glyph
                    // in the accessibility tree, where it reads as a checkmark
                    // on every row including the unselected ones.
                    .opacity(isSelected ? 1 : 0)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 7)
            .contentShape(Rectangle())
            .background {
                RoundedRectangle(cornerRadius: AlpineTheme.Corners.control, style: .continuous)
                    .fill(rowBackground)
            }
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .animation(Motion.feedback, value: isHovering)
        // Selection changes ease the tile, checkmark, and row wash into the
        // new choice's color instead of snapping.
        .animation(Motion.feedback, value: isSelected)
        // Selection is otherwise conveyed by color alone.
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private var rowBackground: Color {
        if isHovering { return Color.primary.opacity(0.075) }
        if isSelected { return accent.opacity(0.14) }
        return .clear
    }
}
