import AppKit
import SwiftUI

// MARK: - Pure helpers (unit-tested)

/// Accent color hex encode/decode used by the per-project color well.
enum SceneryAccentColorCodec {
    static func color(from hex: String?) -> Color? {
        guard let hex, let rgb = AlpineTheme.RGB(hex: hex) else { return nil }
        return rgb.color
    }

    /// Converts a SwiftUI `Color` to `#RRGGBB` via sRGB. Returns nil if the
    /// color cannot be represented in sRGB (e.g. pattern colors, some
    /// wide-gamut samples that AppKit refuses to convert).
    static func hex(from color: Color) -> String? {
        let ns = NSColor(color)
        guard let rgb = ns.usingColorSpace(.sRGB) else { return nil }
        let value = AlpineTheme.RGB(
            red: rgb.redComponent, green: rgb.greenComponent, blue: rgb.blueComponent)
        return value.hexString
    }

    /// Color-well write path: keep the previous stored accent when conversion
    /// fails so a wide-gamut pick cannot clear a saved `accentHex`.
    static func accentHex(from color: Color, preserving previous: String?) -> String? {
        hex(from: color) ?? previous
    }
}

/// Curated SF Symbols for per-project badges (compact picker).
enum SceneryProjectSymbols {
    /// `nil` sentinel in pickers is "None" (clears `sfSymbol`).
    static let curated: [String] = [
        "folder",
        "folder.fill",
        "terminal",
        "hammer",
        "wrench.and.screwdriver",
        "leaf",
        "globe",
        "mountain.2",
        "tree",
        "building.2",
        "laptopcomputer",
        "cpu",
        "shippingbox",
        "book",
        "paintbrush",
        "star",
        "heart",
        "flame",
        "bolt",
        "sparkles",
    ]
}

// MARK: - Settings tab

/// Settings ▸ Scenery: the window-glass translucency slider and per-project
/// accent / symbol badge preferences. The photo pool itself is the built-in
/// 24-location World set — there is nothing to configure per set.
struct ScenerySettingsTab: View {
    let model: AppModel
    let scenery: SceneryStore

    var body: some View {
        VStack(spacing: 18) {
            appearanceSection
            projectsSection
        }
        .animation(Motion.feedback, value: scenery.sceneryTranslucency)
    }

    // MARK: Appearance

    private var appearanceSection: some View {
        SettingsSection(
            header: "Window glass",
            footer:
                "How much of the window the app paints over the blurred desktop. 100% is a fully solid window; at 50% the scene is half transparent and the desktop reads through it. Every new session gets a random photo from the built-in World collection."
        ) {
            SettingsCardRow {
                HStack(spacing: 12) {
                    Slider(
                        value: translucencyBinding,
                        in: ScenerySettingsFile.translucencyRange,
                        label: {
                            Text("Scenery opacity")
                        },
                        minimumValueLabel: {
                            Text("50%")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .monospacedDigit()
                        },
                        maximumValueLabel: {
                            Text("100%")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .monospacedDigit()
                        },
                        onEditingChanged: { editing in
                            if !editing {
                                scenery.flushPendingSettingsSave()
                            }
                        }
                    )
                    .accessibilityLabel("Scenery opacity")
                    .accessibilityValue("\(percentLabel) percent")

                    Text("\(percentLabel)%")
                        .font(.body.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .frame(minWidth: 40, alignment: .trailing)
                        .accessibilityHidden(true)
                }
            }
        }
    }

    private var percentLabel: Int {
        Int((scenery.sceneryTranslucency * 100).rounded())
    }

    private var translucencyBinding: Binding<Double> {
        Binding(
            get: { scenery.sceneryTranslucency },
            set: { scenery.setSceneryTranslucency($0) })
    }

    // MARK: Projects

    private var projectsSection: some View {
        SettingsSection(
            header: "Per project",
            footer: "Accent and symbol appear as subtle badges in the sidebar and chat header."
        ) {
            if model.projects.isEmpty {
                SettingsCardRow {
                    Text("No projects yet. Open a project to assign badge preferences.")
                        .foregroundStyle(.secondary)
                }
            } else {
                ForEach(Array(model.projects.enumerated()), id: \.element.id) { index, project in
                    if index > 0 { SettingsDivider() }
                    SettingsCardRow {
                        ProjectSceneryPrefsRow(
                            project: project,
                            scenery: scenery)
                    }
                }
            }
        }
    }
}

// MARK: - Project prefs row

private struct ProjectSceneryPrefsRow: View {
    let project: Project
    let scenery: SceneryStore
    @UIState private var symbolPopoverPresented = false

    private var prefs: ProjectSceneryPrefs {
        scenery.projectPrefs(for: project.path) ?? ProjectSceneryPrefs()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(project.name)
                    .font(.body.weight(.medium))
                    .lineLimit(1)
                Text(project.path)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
            }

            HStack(alignment: .center, spacing: 12) {
                accentWell
                symbolPicker
            }
        }
    }

    private var accentWell: some View {
        HStack(spacing: 4) {
            ColorPicker(
                "Accent color",
                selection: accentBinding,
                supportsOpacity: false
            )
            .labelsHidden()
            .frame(width: 28, height: 22)
            .accessibilityLabel("Accent color for \(project.name)")

            if prefs.accentHex != nil {
                Button {
                    var next = prefs
                    next.accentHex = nil
                    scenery.setProjectPrefs(next, forProjectPath: project.path)
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                        .imageScale(.small)
                }
                .buttonStyle(.plain)
                .help("Clear accent color")
                .accessibilityLabel("Clear accent color for \(project.name)")
            }
        }
    }

    private var accentBinding: Binding<Color> {
        Binding(
            get: {
                SceneryAccentColorCodec.color(from: prefs.accentHex) ?? AlpineTheme.accent
            },
            set: { newColor in
                var next = prefs
                next.accentHex = SceneryAccentColorCodec.accentHex(
                    from: newColor, preserving: next.accentHex)
                scenery.setProjectPrefs(next, forProjectPath: project.path)
            })
    }

    private var symbolPicker: some View {
        Button {
            symbolPopoverPresented = true
        } label: {
            HStack(spacing: 4) {
                if let symbol = prefs.sfSymbol {
                    Image(systemName: symbol)
                } else {
                    Image(systemName: "square.dashed")
                        .foregroundStyle(.tertiary)
                }
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .frame(minWidth: 36, minHeight: 22)
            .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .help("Project symbol")
        .accessibilityLabel(
            prefs.sfSymbol.map { "Symbol \($0) for \(project.name)" }
                ?? "No symbol for \(project.name)")
        .popover(isPresented: $symbolPopoverPresented, arrowEdge: .bottom) {
            ScenerySymbolGrid(
                selected: prefs.sfSymbol,
                onSelect: { symbol in
                    var next = prefs
                    next.sfSymbol = symbol
                    scenery.setProjectPrefs(next, forProjectPath: project.path)
                    symbolPopoverPresented = false
                })
            .padding(10)
            .frame(width: 220)
        }
    }
}

/// Compact curated SF Symbol grid plus a "None" reset.
private struct ScenerySymbolGrid: View {
    let selected: String?
    let onSelect: (String?) -> Void

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 6), count: 5)

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button("None") { onSelect(nil) }
                .buttonStyle(.borderless)
                .foregroundStyle(selected == nil ? AlpineTheme.accent : .primary)
                .accessibilityLabel("No project symbol")

            LazyVGrid(columns: columns, spacing: 6) {
                ForEach(SceneryProjectSymbols.curated, id: \.self) { symbol in
                    Button {
                        onSelect(symbol)
                    } label: {
                        Image(systemName: symbol)
                            .font(.body)
                            .frame(width: 32, height: 32)
                            .background(
                                RoundedRectangle(cornerRadius: 6, style: .continuous)
                                    .fill(
                                        selected == symbol
                                            ? AlpineTheme.accent.opacity(0.22)
                                            : Color.clear)
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: 6, style: .continuous)
                                    .strokeBorder(
                                        selected == symbol
                                            ? AlpineTheme.accent.opacity(0.5)
                                            : Color.primary.opacity(0.08),
                                        lineWidth: 1)
                            )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(symbol)
                    .accessibilityAddTraits(selected == symbol ? .isSelected : [])
                }
            }
        }
    }
}
