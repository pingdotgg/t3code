import SwiftUI

// Settings chrome: the Alpine skin for the Settings window. Cards replace
// grouped Form sections; the sidebar replaces the NavigationSplitView list.
// Everything here is presentation-only — glass is forbidden in this window,
// so surfaces are plain dark fills and materials.

// MARK: - Card container

/// Section container replacing a grouped Form `Section`: a soft dark card
/// with a hairline edge. Rows inside are composed with `SettingsCardRow`
/// and separated by `SettingsDivider`.
struct SettingsCard<Content: View>: View {
    @ViewBuilder let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        let shape = RoundedRectangle(
            cornerRadius: AlpineTheme.Corners.card, style: .continuous)
        VStack(spacing: 0) { content }
            .padding(.vertical, 2)
            .background(shape.fill(Color.white.opacity(0.055)))
            .clipShape(shape)
            // Top-lit hairline: brighter along the top edge so cards read as
            // raised surfaces instead of outlined rectangles.
            .overlay(
                shape.strokeBorder(
                    LinearGradient(
                        colors: [Color.white.opacity(0.14), Color.white.opacity(0.06)],
                        startPoint: .top,
                        endPoint: .bottom),
                    lineWidth: 1))
            .shadow(color: .black.opacity(0.16), radius: 9, y: 3)
    }
}

/// Consistent insets for a row inside `SettingsCard`: wide enough for
/// breathing room, tight enough that multi-row cards stay compact.
struct SettingsCardRow<Content: View>: View {
    @ViewBuilder let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        content
            .padding(.horizontal, 13)
            .padding(.vertical, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Hairline between card rows, inset on the leading edge so it aligns with
/// the row text rather than running edge to edge.
struct SettingsDivider: View {
    var body: some View {
        Rectangle()
            .fill(Color.white.opacity(0.07))
            .frame(height: 1)
            .padding(.leading, 13)
    }
}

// MARK: - Section

/// A titled group of settings: optional header label (with an optional
/// accent-tinted glyph) above the card and optional footer text below,
/// matching the ComposerPickerSectionLabel and grouped-Form footer roles.
struct SettingsSection<Content: View, HeaderTrailing: View>: View {
    let header: String?
    let icon: String?
    let footer: String?
    @ViewBuilder let headerTrailing: HeaderTrailing
    @ViewBuilder let content: Content

    init(
        header: String? = nil,
        icon: String? = nil,
        footer: String? = nil,
        @ViewBuilder headerTrailing: () -> HeaderTrailing,
        @ViewBuilder content: () -> Content
    ) {
        self.header = header
        self.icon = icon
        self.footer = footer
        self.headerTrailing = headerTrailing()
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let header {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    if let icon {
                        Image(systemName: icon)
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(AlpineTheme.accent)
                    }
                    Text(header)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .textCase(.uppercase)
                        .kerning(0.4)
                    Spacer(minLength: 8)
                    headerTrailing
                }
                .padding(.horizontal, 6)
                .padding(.bottom, 6)
            }

            SettingsCard { content }

            if let footer {
                Text(footer)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 6)
                    .padding(.top, 6)
            }
        }
    }
}

extension SettingsSection where HeaderTrailing == EmptyView {
    init(
        header: String? = nil,
        icon: String? = nil,
        footer: String? = nil,
        @ViewBuilder content: () -> Content
    ) {
        self.init(
            header: header, icon: icon, footer: footer,
            headerTrailing: { EmptyView() }, content: content)
    }
}

// MARK: - Row recipes

/// Title left, tinted switch right, optional descriptive caption beneath —
/// the standard toggle row for every settings card.
struct SettingsToggleRow: View {
    let title: String
    var description: String? = nil
    @Binding var isOn: Bool

    var body: some View {
        SettingsCardRow {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(title)
                        .font(.callout)
                    Spacer(minLength: 12)
                    Toggle(title, isOn: $isOn)
                        .labelsHidden()
                        .toggleStyle(SwitchToggleStyle(tint: AlpineTheme.accent))
                }
                if let description {
                    Text(description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

/// Title left, `.menu` picker right — replaces the Form row picker while
/// keeping the native menu behavior.
struct SettingsPickerRow<SelectionValue: Hashable, Content: View>: View {
    let title: String
    @Binding var selection: SelectionValue
    @ViewBuilder let content: Content

    init(
        _ title: String,
        selection: Binding<SelectionValue>,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        self._selection = selection
        self.content = content()
    }

    var body: some View {
        SettingsCardRow {
            HStack {
                Text(title)
                    .font(.callout)
                Spacer(minLength: 12)
                Picker(title, selection: $selection) { content }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .fixedSize()
            }
        }
    }
}

/// Title left, value right — the `LabeledContent` replacement. Technical
/// values (paths, hosts, versions) use the Geist Mono metadata face.
struct SettingsValueRow<Content: View>: View {
    let title: String
    @ViewBuilder let value: Content

    init(title: String, @ViewBuilder value: () -> Content) {
        self.title = title
        self.value = value()
    }

    var body: some View {
        SettingsCardRow {
            HStack {
                Text(title)
                    .font(.callout)
                Spacer(minLength: 12)
                value
                    .foregroundStyle(.secondary)
            }
        }
    }
}

extension SettingsValueRow where Content == Text {
    init(title: String, value: String, technical: Bool = false) {
        self.init(title: title) {
            Text(value)
                .font(technical ? SurgeTypography.technicalMetadata : .callout)
        }
    }
}

// MARK: - Text fields

/// Quaternary rounded-rect treatment for standalone text inputs — the
/// Alpine counterpart to `.roundedBorder`, safe on content surfaces.
struct SettingsTextFieldStyle: TextFieldStyle {
    func _body(configuration: TextField<_Label>) -> some View {
        configuration
            .textFieldStyle(.plain)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(
                RoundedRectangle(
                    cornerRadius: AlpineTheme.Corners.control, style: .continuous
                )
                .fill(.fill.quaternary)
            )
    }
}

extension TextFieldStyle where Self == SettingsTextFieldStyle {
    static var settings: SettingsTextFieldStyle { SettingsTextFieldStyle() }
}

/// Quaternary rounded-rect search field with a leading magnifying glass.
struct SettingsSearchField: View {
    let prompt: String
    @Binding var text: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .font(.callout)
                .foregroundStyle(.secondary)
            TextField(prompt, text: $text)
                .textFieldStyle(.plain)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(
            RoundedRectangle(
                cornerRadius: AlpineTheme.Corners.control, style: .continuous
            )
            .fill(.fill.quaternary)
        )
    }
}

// MARK: - Sidebar

/// Custom settings sidebar replacing the NavigationSplitView list. Rows
/// mirror the AlpineMenuRow anatomy: 28×28 leading tile (accent + forest
/// glyph when selected), selected wash, hover wash, feedback motion.
struct SettingsSidebar: View {
    @Binding var selection: SettingsTab
    /// True when hosted in the main window: the window toolbar is hidden
    /// under the takeover, so the traffic lights float over this column and
    /// the content has to start below them.
    var inset = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Settings")
                .font(.title3.bold())
                .padding(.horizontal, 8)
                .padding(.bottom, 2)
            group(label: nil, tabs: [.general])
            group(label: "Agents", tabs: [.providers, .workflows, .dictation, .autoReview])
            group(label: "Workspace", tabs: [.archive, .scenery])
            group(label: "Devices", tabs: [.devices, .remoteMacs, .connection])
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .padding(.top, inset ? 48 : 14)
        .frame(width: 196)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Color.white.opacity(0.04).ignoresSafeArea())
    }

    private func group(label: String?, tabs: [SettingsTab]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            if let label {
                Text(label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 8)
                    .padding(.bottom, 3)
            }
            ForEach(tabs) { tab in
                SettingsSidebarRow(
                    tab: tab,
                    isSelected: selection == tab,
                    action: { selection = tab })
            }
        }
    }
}

private struct SettingsSidebarRow: View {
    let tab: SettingsTab
    let isSelected: Bool
    let action: () -> Void

    @UIState private var isHovering = false

    var body: some View {
        Button {
            Haptics.play(.selection, when: !isSelected)
            action()
        } label: {
            HStack(spacing: 10) {
                Image(systemName: tab.symbolName)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(isSelected ? AlpineTheme.forest : Color.secondary)
                    .frame(width: 28, height: 28)
                    .background(
                        isSelected
                            ? AlpineTheme.accent.opacity(0.85)
                            : Color.secondary.opacity(0.09),
                        in: RoundedRectangle(cornerRadius: 7, style: .continuous)
                    )

                Text(tab.title)
                    .font(.callout.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)

                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .contentShape(Rectangle())
            .background {
                RoundedRectangle(
                    cornerRadius: AlpineTheme.Corners.control, style: .continuous
                )
                .fill(rowBackground)
            }
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .animation(Motion.feedback, value: isHovering)
        .animation(Motion.feedback, value: isSelected)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private var rowBackground: Color {
        if isHovering { return Color.primary.opacity(0.075) }
        if isSelected { return AlpineTheme.accent.opacity(0.14) }
        return .clear
    }
}
