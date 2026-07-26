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
    /// Destructive rows carry the app's alert tint. `Button(role:)` styling
    /// only applies inside native menus, so our own surfaces state it here.
    var isDestructive: Bool = false
    /// A row that opens a second page of the same popover keeps the menu up
    /// and shows a trailing chevron, the way a native submenu would.
    var opensSubmenu: Bool = false
    let action: () -> Void
    @ViewBuilder let leading: Leading

    @UIState private var isHovering = false
    @Environment(\.isEnabled) private var isEnabled

    init(
        title: String,
        detail: String? = nil,
        isSelected: Bool = false,
        isDestructive: Bool = false,
        opensSubmenu: Bool = false,
        action: @escaping () -> Void,
        @ViewBuilder leading: () -> Leading
    ) {
        self.title = title
        self.detail = detail
        self.isSelected = isSelected
        self.isDestructive = isDestructive
        self.opensSubmenu = opensSubmenu
        self.action = action
        self.leading = leading()
    }

    var body: some View {
        Button {
            Haptics.play(.selection)
            action()
        } label: {
            HStack(spacing: 10) {
                leading
                    // SF Symbol sizing; custom leading views (ProviderIcon)
                    // size themselves and ignore the font.
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(leadingForeground)
                    .frame(width: 28, height: 28)
                    .background(
                        leadingBackground,
                        in: RoundedRectangle(cornerRadius: 7, style: .continuous)
                    )

                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(.callout.weight(.medium))
                        .foregroundStyle(isDestructive ? AlpineTheme.destructive : Color.primary)
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
                } else if opensSubmenu {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.tertiary)
                        .frame(width: 22, height: 22)
                        .accessibilityHidden(true)
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

    private var leadingForeground: Color {
        if isDestructive { return AlpineTheme.destructive }
        return isSelected ? AlpineTheme.forest : .secondary
    }

    private var leadingBackground: Color {
        if isDestructive { return AlpineTheme.destructive.opacity(0.14) }
        return isSelected ? AlpineTheme.accent.opacity(0.85) : Color.secondary.opacity(0.09)
    }

    private var rowBackground: Color {
        if isHovering, isEnabled {
            return isDestructive
                ? AlpineTheme.destructive.opacity(0.13)
                : Color.primary.opacity(0.075)
        }
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
        isDestructive: Bool = false,
        opensSubmenu: Bool = false,
        action: @escaping () -> Void
    ) {
        self.init(
            title: title,
            detail: detail,
            isSelected: isSelected,
            isDestructive: isDestructive,
            opensSubmenu: opensSubmenu,
            action: action
        ) {
            Image(systemName: icon)
        }
    }
}

/// Group separator inside an Alpine popover menu. Softer and tighter than a
/// bare `Divider()`, and inset to the row gutter so it reads as a grouping
/// hint rather than a structural edge.
struct AlpineMenuSeparator: View {
    var body: some View {
        Divider()
            .opacity(0.45)
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
    }
}

/// The row well of an Alpine popover menu: one consistent gutter and row
/// spacing for every menu, so a two-item menu and a ten-item menu have the
/// same rhythm.
struct AlpineMenuList<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(spacing: 2) {
            content
        }
        .padding(6)
    }
}
