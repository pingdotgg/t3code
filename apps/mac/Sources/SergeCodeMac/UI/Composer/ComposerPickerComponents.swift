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

    var body: some View {
        HStack(spacing: 10) {
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
    let action: () -> Void

    @UIState private var isHovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                if let icon {
                    Image(systemName: icon)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(isSelected ? AlpineTheme.forest : Color.secondary)
                        .frame(width: 28, height: 28)
                        .background(
                            isSelected ? AlpineTheme.accent.opacity(0.85) : Color.secondary.opacity(0.09),
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
                    .background(AlpineTheme.accent, in: Circle())
                    .opacity(isSelected ? 1 : 0)
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
    }

    private var rowBackground: Color {
        if isHovering { return Color.primary.opacity(0.075) }
        if isSelected { return AlpineTheme.accent.opacity(0.14) }
        return .clear
    }
}
