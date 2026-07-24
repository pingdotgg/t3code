import SwiftUI

/// Action row for Alpine popover menus — the custom-dropdown counterpart to
/// `ComposerPickerChoiceRow` (which is selection-oriented and always reserves
/// a checkmark gutter). Leading content is generic so SF Symbols and provider
/// marks (`ProviderIcon`) share one layout; surfaces come from
/// `ComposerPickerSurface`.
struct AlpineMenuRow<Leading: View>: View {
    let title: String
    var detail: String? = nil
    /// Selection menus (e.g. the branch picker) mark the active row; plain
    /// action rows leave this false and get no trailing affordance.
    var isSelected: Bool = false
    let action: () -> Void
    @ViewBuilder let leading: Leading

    @UIState private var isHovering = false
    @Environment(\.isEnabled) private var isEnabled

    init(
        title: String,
        detail: String? = nil,
        isSelected: Bool = false,
        action: @escaping () -> Void,
        @ViewBuilder leading: () -> Leading
    ) {
        self.title = title
        self.detail = detail
        self.isSelected = isSelected
        self.action = action
        self.leading = leading()
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                leading
                    // SF Symbol sizing; custom leading views (ProviderIcon)
                    // size themselves and ignore the font.
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(isSelected ? AlpineTheme.forest : Color.secondary)
                    .frame(width: 28, height: 28)
                    .background(
                        isSelected
                            ? AlpineTheme.accent.opacity(0.85)
                            : Color.secondary.opacity(0.09),
                        in: RoundedRectangle(cornerRadius: 7, style: .continuous)
                    )

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

                if isSelected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(AlpineTheme.forest)
                        .frame(width: 22, height: 22)
                        .background(AlpineTheme.accent, in: Circle())
                }
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
        .opacity(isEnabled ? 1 : 0.45)
        .onHover { isHovering = $0 }
        .animation(Motion.feedback, value: isHovering)
    }

    private var rowBackground: Color {
        if isHovering, isEnabled { return Color.primary.opacity(0.075) }
        if isSelected { return AlpineTheme.accent.opacity(0.14) }
        return .clear
    }
}

extension AlpineMenuRow where Leading == Image {
    /// SF Symbol leading tile.
    init(
        icon: String,
        title: String,
        detail: String? = nil,
        isSelected: Bool = false,
        action: @escaping () -> Void
    ) {
        self.init(title: title, detail: detail, isSelected: isSelected, action: action) {
            Image(systemName: icon)
        }
    }
}
