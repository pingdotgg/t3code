import AppKit
import SwiftUI

// MARK: - Pure helpers (unit-tested)

/// User-facing copy for scenery set creation failures. Centralized so Settings
/// UI and tests share one mapping (LocalizedError remains the source of truth
/// for most cases; missing key gets an explicit path hint).
enum SceneSetComposerUserMessage {
    static func message(for error: SceneSetComposer.SceneSetComposerError) -> String {
        switch error {
        case .missingUnsplashKey:
            return
                "Unsplash access key is missing. Set the SERGECODE_UNSPLASH_KEY environment variable, or save the key to ~/Library/Application Support/SergeCode/unsplash-access-key."
        default:
            return error.errorDescription
                ?? "Something went wrong while creating the scenery set."
        }
    }
}

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

/// Settings ▸ Scenery: set gallery, create-set flow, default/delete actions,
/// and per-project set / accent / symbol preferences.
struct ScenerySettingsTab: View {
    let model: AppModel
    let scenery: SceneryStore
    let composer: SceneSetComposer

    @UIState private var locationName = ""
    @UIState private var setPendingDelete: ScenerySet?
    @UIState private var showDeleteConfirm = false
    @UIState private var deleteError: String?

    private var isComposerBusy: Bool {
        switch composer.state {
        case .generatingNames, .fetchingPhotos: true
        default: false
        }
    }

    var body: some View {
        Form {
            createSetSection
            photoSetsSection
            projectsSection
        }
        .formStyle(.grouped)
        .padding()
        .animation(Motion.settle, value: scenery.availableSets.map(\.id))
        .animation(Motion.settle, value: scenery.defaultSetId)
        .animation(Motion.fade, value: composer.state)
        .confirmationDialog(
            "Delete scenery set?",
            isPresented: $showDeleteConfirm,
            titleVisibility: .visible,
            presenting: setPendingDelete
        ) { set in
            Button("Delete “\(set.title)”", role: .destructive) {
                deleteSet(set)
            }
            Button("Cancel", role: .cancel) {
                setPendingDelete = nil
            }
        } message: { set in
            Text(
                "Threads using “\(set.title)” will fall back to the default scenery set. This cannot be undone."
            )
        }
        .alert(
            "Couldn't delete scenery set",
            isPresented: Binding(
                get: { deleteError != nil },
                set: { if !$0 { deleteError = nil } }
            )
        ) {
            Button("OK", role: .cancel) { deleteError = nil }
        } message: {
            Text(deleteError ?? "Something went wrong while deleting the scenery set.")
        }
    }

    // MARK: Create

    private var createSetSection: some View {
        Section {
            HStack(spacing: 10) {
                TextField("Location name", text: $locationName)
                    .textFieldStyle(.roundedBorder)
                    .disabled(isComposerBusy)
                    .onSubmit { createIfPossible() }
                    .accessibilityLabel("Location name for new scenery set")

                Button("Create") { createIfPossible() }
                    .disabled(
                        isComposerBusy
                            || locationName.trimmingCharacters(in: .whitespacesAndNewlines)
                                .isEmpty)
                    .keyboardShortcut(.defaultAction)
            }

            composerStatusRow
        } header: {
            Text("Create set")
        } footer: {
            Text(
                "Generates a curated photo set for a place. Requires an Unsplash access key and a connected coding provider for AI place names (templated queries are used if the provider is unavailable)."
            )
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var composerStatusRow: some View {
        switch composer.state {
        case .idle:
            EmptyView()
        case .generatingNames:
            HStack(spacing: 10) {
                ProgressView()
                    .controlSize(.small)
                Text("Generating place names…")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Cancel") { composer.cancel() }
                    .controlSize(.small)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Generating place names")
        case .fetchingPhotos(let completed, let total):
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 10) {
                    ProgressView(value: Double(completed), total: Double(max(total, 1)))
                        .frame(maxWidth: 180)
                    Text("\(completed)/\(total)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                    Spacer()
                    Button("Cancel") { composer.cancel() }
                        .controlSize(.small)
                }
                Text("Fetching photos…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Fetching photos, \(completed) of \(total)")
        case .finished(let setId):
            HStack(spacing: 8) {
                Label(
                    "Created \(scenery.set(id: setId)?.title ?? "set")",
                    systemImage: "checkmark.circle.fill"
                )
                .foregroundStyle(.green)
                .font(.callout)
                Spacer()
                Button("Dismiss") {
                    locationName = ""
                    composer.reset()
                }
                .controlSize(.small)
            }
        case .failed(let error):
            HStack(alignment: .top, spacing: 8) {
                Label(
                    SceneSetComposerUserMessage.message(for: error),
                    systemImage: "exclamationmark.triangle.fill"
                )
                .foregroundStyle(error == .cancelled ? Color.secondary : Color.red)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                Button("Dismiss") { composer.reset() }
                    .controlSize(.small)
            }
        }
    }

    // MARK: Gallery

    private var photoSetsSection: some View {
        Section("Photo sets") {
            if scenery.availableSets.isEmpty {
                Text("No scenery sets loaded yet.")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(scenery.availableSets) { set in
                    ScenerySetGalleryRow(
                        set: set,
                        scenery: scenery,
                        isDefault: set.id == scenery.defaultSetId,
                        onSetDefault: { scenery.setDefaultSetId(set.id) },
                        onDelete: {
                            setPendingDelete = set
                            showDeleteConfirm = true
                        }
                    )
                    .padding(.vertical, 2)
                }
            }
        }
    }

    // MARK: Projects

    private var projectsSection: some View {
        Section {
            if model.projects.isEmpty {
                Text("No projects yet. Open a project to assign scenery preferences.")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(model.projects) { project in
                    ProjectSceneryPrefsRow(
                        project: project,
                        scenery: scenery)
                    .padding(.vertical, 2)
                }
            }
        } header: {
            Text("Per project")
        } footer: {
            Text(
                "When a project has no set chosen, it uses the default photo set. Accent and symbol appear as subtle badges in the sidebar and chat header."
            )
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    // MARK: Actions

    private func createIfPossible() {
        guard !isComposerBusy else { return }
        let trimmed = locationName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        composer.createSet(location: trimmed)
    }

    private func deleteSet(_ set: ScenerySet) {
        defer { setPendingDelete = nil }
        do {
            try scenery.deleteCustomSet(id: set.id)
        } catch let err as SceneryStore.DeleteSetError {
            // Dialog only offers custom sets; not-found / builtin are no-ops.
            switch err {
            case .notFound, .builtinProtected:
                break
            }
        } catch {
            deleteError =
                (error as? LocalizedError)?.errorDescription
                ?? error.localizedDescription
        }
    }
}

// MARK: - Gallery row

private struct ScenerySetGalleryRow: View {
    let set: ScenerySet
    let scenery: SceneryStore
    let isDefault: Bool
    let onSetDefault: () -> Void
    let onDelete: () -> Void

    private var photos: [SceneryPhoto] {
        Array(scenery.photos(forSetId: set.id).prefix(4))
    }

    private var photoCount: Int {
        scenery.photos(forSetId: set.id).count
    }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            ScenerySetCollageView(
                photos: photos,
                scenery: scenery,
                set: set)
                .frame(width: 72, height: 52)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .strokeBorder(.white.opacity(0.08), lineWidth: 1)
                )
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(set.title)
                        .font(.body.weight(.medium))
                        .lineLimit(1)
                    if isDefault {
                        Text("Default")
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1)
                            .background(
                                Capsule(style: .continuous)
                                    .fill(AlpineTheme.accent.opacity(0.22)))
                            .foregroundStyle(AlpineTheme.accent)
                            .accessibilityLabel("Default set")
                    }
                    if set.origin == .builtin {
                        Text("Built-in")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                Text(photoCount == 1 ? "1 photo" : "\(photoCount) photos")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 8)

            Menu {
                if !isDefault {
                    Button("Set as Default") { onSetDefault() }
                }
                if set.origin == .custom {
                    Divider()
                    Button("Delete…", role: .destructive) { onDelete() }
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .accessibilityLabel("Actions for \(set.title)")
            .help("Set actions")
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilitySummary)
    }

    private var accessibilitySummary: String {
        var parts = [set.title]
        if isDefault { parts.append("default") }
        if set.origin == .builtin { parts.append("built-in") }
        parts.append("\(photoCount) photos")
        return parts.joined(separator: ", ")
    }
}

/// 2×2 thumbnail collage, or a palette gradient placeholder when empty.
private struct ScenerySetCollageView: View {
    let photos: [SceneryPhoto]
    let scenery: SceneryStore
    let set: ScenerySet

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let h = geo.size.height
            let gap: CGFloat = 1
            if photos.isEmpty {
                AlpineTheme.gradient(seed: set.id, palette: set.palette)
            } else if photos.count == 1 {
                collageCell(photos[0])
            } else {
                let cellW = (w - gap) / 2
                let cellH = (h - gap) / 2
                VStack(spacing: gap) {
                    HStack(spacing: gap) {
                        collageCell(photos[0])
                            .frame(width: cellW, height: cellH)
                        if photos.count > 1 {
                            collageCell(photos[1])
                                .frame(width: cellW, height: cellH)
                        } else {
                            Color.clear.frame(width: cellW, height: cellH)
                        }
                    }
                    HStack(spacing: gap) {
                        if photos.count > 2 {
                            collageCell(photos[2])
                                .frame(width: cellW, height: cellH)
                        } else {
                            placeholderWash(seed: set.id + "-a")
                                .frame(width: cellW, height: cellH)
                        }
                        if photos.count > 3 {
                            collageCell(photos[3])
                                .frame(width: cellW, height: cellH)
                        } else {
                            placeholderWash(seed: set.id + "-b")
                                .frame(width: cellW, height: cellH)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func collageCell(_ photo: SceneryPhoto) -> some View {
        SceneryImageView(
            scenery: scenery,
            photo: photo,
            variant: .thumb,
            setId: set.id,
            fallbackSeed: photo.id)
    }

    private func placeholderWash(seed: String) -> some View {
        AlpineTheme.gradient(seed: seed, palette: set.palette)
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

    /// Picker tag: empty string means "use Default".
    private var selectedSetTag: String {
        prefs.setId ?? ""
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
                Picker("Scenery set", selection: setIdBinding) {
                    Text("Default").tag("")
                    ForEach(scenery.availableSets) { set in
                        Text(set.title).tag(set.id)
                    }
                }
                .labelsHidden()
                .frame(maxWidth: 160)
                .accessibilityLabel("Scenery set for \(project.name)")

                accentWell
                symbolPicker
            }
        }
    }

    private var setIdBinding: Binding<String> {
        Binding(
            get: { selectedSetTag },
            set: { newValue in
                var next = prefs
                next.setId = newValue.isEmpty ? nil : newValue
                scenery.setProjectPrefs(next, forProjectPath: project.path)
            })
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
