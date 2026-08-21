import SwiftUI

public struct SettingsView: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @Bindable private var model: FeatureRootModel
    @State private var settings: FeatureSettings
    @State private var isSaving = false
    @State private var saveErrorMessage: String?

    public init(model: FeatureRootModel) {
        self.model = model
        _settings = State(initialValue: model.snapshot.settings)
    }

    public var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                settingsHeader

                Divider()
                    .overlay(T3Colors.border)

                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 28) {
                        connectionSection
                        generalSection
                        preferencesSection
                        textSizeSection
                        aboutSection
                    }
                    .padding(.vertical, 18)
                }
                .scrollDismissesKeyboard(.interactively)
            }
            .background(T3Colors.background)
            .toolbar(.hidden, for: .navigationBar)
            .alert(
                "Couldn’t save settings",
                isPresented: Binding(
                    get: { saveErrorMessage != nil },
                    set: { if !$0 { saveErrorMessage = nil } }
                )
            ) {
                Button("OK") { saveErrorMessage = nil }
            } message: {
                Text(saveErrorMessage ?? "Something went wrong.")
            }
            .onAppear {
                model.setConnectionManagementPresented(true)
            }
            .onDisappear {
                model.setConnectionManagementPresented(false)
            }
            .onChange(of: settings.appearance) { _, appearance in
                Task {
                    let didSave = await model.saveAppearance(appearance)
                    if !didSave {
                        settings.appearance = model.snapshot.settings.appearance
                        saveErrorMessage = model.errorMessage
                            ?? "Theme preference could not be saved."
                    }
                }
            }
            .onChange(of: settings.textSize) { _, _ in saveTextSizes() }
            .onChange(of: settings.codeSize) { _, _ in saveTextSizes() }
        }
        .presentationDragIndicator(.visible)
        // Settings is itself a sheet, hosted outside the app root's
        // environment, so the code size has to be republished for the preview
        // below to answer the control the reader is dragging.
        .t3CodeSizing(steps: model.snapshot.settings.codeSize.steps)
    }

    private var settingsHeader: some View {
        HStack(spacing: 12) {
            Button("Cancel") { dismiss() }
                .frame(width: 72, alignment: .leading)
                .foregroundStyle(T3Colors.accent)

            Spacer(minLength: 0)

            Text("Settings")
                .font(T3Typography.navigationTitle)
                .foregroundStyle(T3Colors.textPrimary)

            Spacer(minLength: 0)

            Button(isSaving ? "Saving…" : "Save") {
                save()
            }
            .fontWeight(.semibold)
            .frame(width: 72, alignment: .trailing)
            .foregroundStyle(canSave ? T3Colors.accent : T3Colors.textTertiary)
            .disabled(!canSave)
        }
        .font(T3Typography.control)
        .padding(.horizontal, 20)
        .frame(minHeight: 54)
    }

    private var connectionSection: some View {
        SettingsSection(title: "Environments") {
            NavigationLink {
                ConnectionsView(model: model)
            } label: {
                SettingsNavigationRow(
                    title: "Environments",
                    systemImage: "server.rack"
                )
            }
            .buttonStyle(.plain)
        }
    }

    private var generalSection: some View {
        SettingsSection(title: "General") {
            VStack(spacing: 0) {
                NavigationLink {
                    PullRequestsView(model: model)
                } label: {
                    SettingsNavigationRow(
                        title: "Pull Requests",
                        systemImage: "arrow.triangle.pull"
                    )
                }
                .buttonStyle(.plain)
                settingsDivider
                NavigationLink {
                    UsageView(client: model.client)
                } label: {
                    SettingsNavigationRow(
                        title: "Usage",
                        systemImage: "chart.bar.xaxis"
                    )
                }
                .buttonStyle(.plain)
            }
        }
    }


    private var preferencesSection: some View {
        SettingsSection(title: "Preferences") {
            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    SettingsRowIcon(systemName: "circle.lefthalf.filled")
                    Text("Theme")
                        .font(T3Typography.threadBody)
                    Spacer(minLength: 12)
                    Picker("Theme", selection: $settings.appearance) {
                        Text("System").tag(FeatureAppearance.system)
                        Text("Light").tag(FeatureAppearance.light)
                        Text("Dark").tag(FeatureAppearance.dark)
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .tint(T3Colors.textSecondary)
                }
                .padding(.horizontal, 20)
                .frame(minHeight: 52)

                settingsDivider
                SettingsToggleRow(
                    title: "Haptics",
                    systemImage: "iphone.radiowaves.left.and.right",
                    isOn: $settings.hapticsEnabled
                )
                settingsDivider
                SettingsToggleRow(
                    title: "Notifications",
                    systemImage: "bell",
                    isOn: $settings.notificationsEnabled
                )
                settingsDivider
                SettingsToggleRow(
                    title: "Live Activities",
                    systemImage: "waveform.path.ecg.rectangle",
                    isOn: $settings.liveActivitiesEnabled
                )
            }
        }
    }

    private var textSizeSection: some View {
        SettingsSection(
            title: "Text & Code",
            footer: """
                Both sizes are relative to your iOS text size in Settings › \
                Display & Brightness, so Dynamic Type and the Accessibility \
                sizes keep working. Code size applies to code blocks, diffs, \
                file contents, and tool output.
                """
        ) {
            VStack(spacing: 0) {
                SettingsTextSizePreview()
                settingsDivider
                SettingsTextSizeRow(
                    title: "Text size",
                    systemImage: "textformat.size",
                    adjustment: $settings.textSize
                )
                settingsDivider
                SettingsTextSizeRow(
                    title: "Code size",
                    systemImage: "chevron.left.forwardslash.chevron.right",
                    adjustment: $settings.codeSize
                )
            }
        }
    }

    private var aboutSection: some View {
        SettingsSection(title: "About") {
            VStack(spacing: 0) {
                SettingsValueRow(title: "App", value: appDisplayName)
                settingsDivider
                SettingsValueRow(title: "Platform", value: "Native SwiftUI")
                settingsDivider
                SettingsValueRow(title: "Version", value: appVersionLabel)
                if let appCommit {
                    settingsDivider
                    SettingsValueRow(title: "Commit", value: appCommit)
                }
                settingsDivider
                Link(destination: URL(string: "https://github.com/pingdotgg/t3code")!) {
                    SettingsNavigationRow(
                        title: "Open source",
                        systemImage: "chevron.left.forwardslash.chevron.right",
                        trailingSystemImage: "arrow.up.right"
                    )
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var settingsDivider: some View {
        Divider()
            .overlay(T3Colors.separator)
            .padding(.leading, 54)
            .padding(.trailing, 20)
    }

    private var appDisplayName: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
            ?? "T3 Code SwiftUI"
    }

    private var appVersionLabel: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
            ?? "?"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
            ?? "?"
        return "\(version) (\(build))"
    }

    private var appCommit: String? {
        guard let commit = Bundle.main.object(forInfoDictionaryKey: "T3GitCommit") as? String,
              commit.isEmpty == false,
              commit.hasPrefix("$(") == false else { return nil }
        return String(commit.prefix(8))
    }

    private var canSave: Bool {
        !isSaving && settings != model.snapshot.settings
    }

    /// Sizes persist as they are dragged rather than waiting for Save, so the
    /// whole app — this sheet included — resizes under the reader's finger and
    /// the preview is the real thing rather than a mock-up.
    @MainActor
    private func saveTextSizes() {
        Task {
            let didSave = await model.saveTextSizes(
                textSize: settings.textSize,
                codeSize: settings.codeSize
            )
            if !didSave {
                settings.textSize = model.snapshot.settings.textSize
                settings.codeSize = model.snapshot.settings.codeSize
                saveErrorMessage = model.errorMessage
                    ?? "Text size preference could not be saved."
            }
        }
    }

    @MainActor
    private func save() {
        isSaving = true
        Task {
            let didSave = await model.saveSettings(settings)
            isSaving = false
            if didSave {
                dismiss()
            } else {
                saveErrorMessage = model.errorMessage ?? "Settings could not be saved."
            }
        }
    }
}

private struct SettingsSection<Content: View>: View {
    let title: String
    let footer: String?
    let content: Content

    init(
        title: String,
        footer: String? = nil,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        self.footer = footer
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(T3Typography.supportingStrong)
                .foregroundStyle(T3Colors.textSecondary)
                .padding(.horizontal, 20)

            content

            if let footer {
                Text(footer)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textTertiary)
                    .padding(.horizontal, 20)
                    .padding(.top, 2)
            }
        }
    }
}

private struct SettingsRowIcon: View {
    let systemName: String
    var color: Color = T3Colors.accent

    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: 17, weight: .medium))
            .foregroundStyle(color)
            .frame(width: 22, height: 22)
            .accessibilityHidden(true)
    }
}

private struct SettingsNavigationRow: View {
    let title: String
    var value: String? = nil
    let systemImage: String
    var trailingSystemImage = "chevron.right"

    var body: some View {
        HStack(spacing: 12) {
            SettingsRowIcon(systemName: systemImage)
            Text(title)
                .font(T3Typography.threadBody)
                .foregroundStyle(T3Colors.textPrimary)
            Spacer(minLength: 8)
            if let value {
                Text(value)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                    .lineLimit(1)
            }
            Image(systemName: trailingSystemImage)
                .font(T3Typography.supportingStrong)
                .foregroundStyle(T3Colors.textTertiary)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, 20)
        .frame(minHeight: 52)
        .contentShape(Rectangle())
    }
}

private struct SettingsActionRow: View {
    let title: String
    let systemImage: String
    var color: Color = T3Colors.accent

    var body: some View {
        HStack(spacing: 12) {
            SettingsRowIcon(systemName: systemImage, color: color)
            Text(title)
                .font(T3Typography.threadBody)
                .foregroundStyle(color)
            Spacer(minLength: 8)
        }
        .padding(.horizontal, 20)
        .frame(minHeight: 52)
        .contentShape(Rectangle())
    }
}

private struct SettingsValueRow: View {
    let title: String
    let value: String
    var systemImage: String? = nil

    var body: some View {
        HStack(spacing: 12) {
            if let systemImage {
                SettingsRowIcon(systemName: systemImage)
            }
            Text(title)
                .font(T3Typography.threadBody)
                .foregroundStyle(T3Colors.textPrimary)
            Spacer(minLength: 12)
            Text(value)
                .font(T3Typography.threadBody)
                .foregroundStyle(T3Colors.textSecondary)
                .lineLimit(1)
        }
        .padding(.horizontal, 20)
        .frame(minHeight: 52)
        .accessibilityElement(children: .combine)
    }
}

/// Live sample of both sizes. Size changes save as they happen, so this is the
/// app's real transcript and diff styling rather than a separate mock-up.
private struct SettingsTextSizePreview: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text("Rewrote the failing test and re-ran the suite.")
                .font(T3Typography.threadBody)
                .foregroundStyle(T3Colors.textPrimary)
                .fixedSize(horizontal: false, vertical: true)

            Text(verbatim: "- expect(total).toBe(41)\n+ expect(total).toBe(42)")
                .font(T3Typography.code)
                .foregroundStyle(T3Colors.textSecondary)
                .t3CodeTextSize()
                .fixedSize(horizontal: false, vertical: true)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    T3Colors.surfaceRaised,
                    in: RoundedRectangle(cornerRadius: 8, style: .continuous)
                )
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Preview of the selected text and code sizes")
    }
}

private struct SettingsTextSizeRow: View {
    let title: String
    let systemImage: String
    @Binding var adjustment: FeatureTextSizeAdjustment

    private var steps: Binding<Double> {
        Binding(
            get: { Double(adjustment.steps) },
            set: { adjustment = FeatureTextSizeAdjustment(steps: Int($0.rounded())) }
        )
    }

    private var sliderBounds: ClosedRange<Double> {
        Double(FeatureTextSizeAdjustment.range.lowerBound)
            ... Double(FeatureTextSizeAdjustment.range.upperBound)
    }

    private var valueLabel: String {
        switch adjustment.steps {
        case ...(-2): "Much smaller"
        case -1: "Smaller"
        case 0: "Default"
        case 1: "Larger"
        case 2: "Much larger"
        default: "Largest"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 12) {
                SettingsRowIcon(systemName: systemImage)
                Text(title)
                    .font(T3Typography.threadBody)
                    .foregroundStyle(T3Colors.textPrimary)
                Spacer(minLength: 12)
                Text(valueLabel)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
            }
            .accessibilityHidden(true)

            HStack(spacing: 12) {
                Image(systemName: "textformat.size.smaller")
                    .font(T3Typography.supporting)
                Slider(value: steps, in: sliderBounds, step: 1) {
                    Text(title)
                }
                .tint(T3Colors.accent)
                .accessibilityValue(valueLabel)
                Image(systemName: "textformat.size.larger")
                    .font(T3Typography.navigationTitle)
            }
            .foregroundStyle(T3Colors.textTertiary)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 10)
        .frame(minHeight: 52)
    }
}

private struct SettingsToggleRow: View {
    let title: String
    let systemImage: String
    @Binding var isOn: Bool

    var body: some View {
        Toggle(isOn: $isOn) {
            HStack(spacing: 12) {
                SettingsRowIcon(systemName: systemImage)
                Text(title)
                    .font(T3Typography.threadBody)
                    .foregroundStyle(T3Colors.textPrimary)
            }
        }
        .tint(T3Colors.accent)
        .padding(.horizontal, 20)
        .frame(minHeight: 52)
    }
}

private struct SettingsStatusLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 4) {
            configuration.icon
            configuration.title
        }
    }
}
