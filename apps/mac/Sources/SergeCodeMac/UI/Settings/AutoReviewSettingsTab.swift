import SwiftUI
import T3Kit

/// Settings tab for the native auto-review system (SER-141).
struct AutoReviewSettingsTab: View {
    let model: AppModel
    @UIState private var draft: AppSettings?
    @UIState private var jobs: [AppAutoReviewJob] = []
    @UIState private var isRefreshingJobs = false
    @UIState private var loadError: String?
    @FocusState private var mentionFocused: Bool
    @FocusState private var intervalFocused: Bool

    var body: some View {
        VStack(spacing: 18) {
            if let settings = draft {
                SettingsSection {
                    SettingsToggleRow(
                        title: "Enable auto-review",
                        description:
                            "When enabled, SurgeCode polls open GitHub PRs for your projects, posts a review with your selected model, and can auto-prompt the origin thread to fix blocking/important findings.",
                        isOn: binding(settings, \.autoReview.enabled))
                }

                SettingsSection(header: "When to run") {
                    SettingsCardRow {
                        HStack {
                            Text("Mode")
                                .font(.callout)
                            Spacer()
                            AlpineSegmentedControl(
                                segments: [
                                    AlpineSegmentedControl<String>.Segment(
                                        value: "auto", title: "Auto on open / push"),
                                    AlpineSegmentedControl<String>.Segment(
                                        value: "mention", title: "Only when @mentioned"),
                                ],
                                selection: binding(settings, \.autoReview.mode),
                                height: 26
                            )
                            .frame(width: 300)
                            .disabled(!settings.autoReview.enabled)
                        }
                    }
                    SettingsDivider()
                    SettingsCardRow {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Mention handle")
                                .font(.callout)
                            TextField(
                                "Mention handle",
                                text: textBinding(settings, \.autoReview.mentionHandle))
                                .textFieldStyle(.settings)
                                .focused($mentionFocused)
                                .disabled(
                                    !settings.autoReview.enabled
                                        || settings.autoReview.mode != "mention")
                                .help(
                                    "GitHub comment trigger, without the @ (default: surgecode)")
                        }
                    }
                    SettingsDivider()
                    SettingsToggleRow(
                        title: "Auto-fix origin thread",
                        isOn: binding(settings, \.autoReview.autoFixOriginThread))
                        .disabled(!settings.autoReview.enabled)
                        .help(
                            "After a review with blocking/important findings, prompt the linked SurgeCode thread that opened the PR."
                        )
                }

                SettingsSection(header: "Model") {
                    if model.models.isEmpty {
                        SettingsCardRow {
                            HStack {
                                Text("Model")
                                    .font(.callout)
                                Spacer()
                                Text(
                                    "\(settings.autoReview.modelInstanceID)/\(settings.autoReview.modelID)"
                                )
                                .font(SurgeTypography.technicalMetadata)
                                .foregroundStyle(.secondary)
                            }
                            .disabled(true)
                        }
                    } else {
                        modelPairPicker(settings)
                    }
                }

                SettingsSection(header: "Polling") {
                    SettingsCardRow {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text("Interval")
                                    .font(.callout)
                                Spacer()
                                TextField(
                                    "seconds",
                                    value: Binding(
                                        get: {
                                            (draft ?? settings).autoReview.pollIntervalSeconds
                                        },
                                        set: { newValue in
                                            var next = draft ?? settings
                                            next.autoReview.pollIntervalSeconds = min(
                                                600, max(15, newValue))
                                            draft = next
                                        }),
                                    format: .number)
                                    .textFieldStyle(.settings)
                                    .frame(width: 72)
                                    .multilineTextAlignment(.trailing)
                                    .focused($intervalFocused)
                                    .onSubmit { commitTextFields() }
                                    .disabled(!settings.autoReview.enabled)
                                Text("sec")
                                    .foregroundStyle(.secondary)
                            }
                            Text("Clamped to 15–600 seconds on the server.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    SettingsDivider()
                    SettingsCardRow {
                        VStack(alignment: .leading, spacing: 6) {
                            Stepper(
                                "Max attempts: \(settings.autoReview.maxAttempts)",
                                value: binding(settings, \.autoReview.maxAttempts),
                                in: 1...5)
                                .disabled(!settings.autoReview.enabled)
                            Text("Failed reviews retry up to this many times per PR head, then stop.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                if !settings.autoReview.projectOverrides.isEmpty {
                    SettingsSection(header: "Projects") {
                        ForEach(
                            Array(settings.autoReview.projectOverrides.enumerated()),
                            id: \.element.id
                        ) { index, override in
                            if index > 0 { SettingsDivider() }
                            projectOverrideRow(settings, index: index, override: override)
                        }
                    }
                }

                SettingsSection(header: "Recent jobs") {
                    if isRefreshingJobs && jobs.isEmpty {
                        SettingsCardRow {
                            ProgressView()
                                .frame(maxWidth: .infinity)
                        }
                    } else if jobs.isEmpty {
                        SettingsCardRow {
                            Text(
                                settings.autoReview.enabled
                                    ? "No auto-review jobs yet. Open or update a PR on a project repo."
                                    : "Enable auto-review to start polling."
                            )
                            .foregroundStyle(.secondary)
                        }
                    } else {
                        ForEach(Array(jobs.enumerated()), id: \.element.id) { index, job in
                            if index > 0 { SettingsDivider() }
                            jobRow(job)
                        }
                    }
                    SettingsDivider()
                    SettingsCardRow {
                        Button("Refresh jobs") {
                            Task { await refreshJobs() }
                        }
                        .controlSize(.small)
                        .disabled(model.connection != .ready)
                    }
                }
            } else {
                SettingsSection {
                    SettingsCardRow {
                        if let loadError {
                            VStack(alignment: .leading, spacing: 8) {
                                Label(
                                    "Could not load auto-review settings",
                                    systemImage: "exclamationmark.triangle"
                                )
                                .foregroundStyle(.red)
                                Text(loadError)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Button("Try Again") {
                                    Task { await loadDraft() }
                                }
                                .controlSize(.small)
                            }
                        } else if model.connection == .ready {
                            ProgressView()
                                .frame(maxWidth: .infinity)
                        } else {
                            Text("Connect to the server to edit auto-review settings.")
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .animation(Motion.reveal, value: draft == nil)
        // A tab opened while the sidecar is still booting would load nothing
        // and never retry, so key the task on the connection phase. Gated on
        // `.ready` because `.reconnecting(attempt:)` bumps on every restart
        // attempt and each of those loads could only fail again.
        .task(id: model.connection) {
            guard model.connection == .ready else { return }
            if draft == nil { await loadDraft() }
            await refreshJobs()
        }
        .onChange(of: mentionFocused) { wasFocused, isFocused in
            if wasFocused && !isFocused { commitTextFields() }
        }
        // Blur commits too: the interval is a free-text field, so leaving it
        // for another control must not silently drop the typed value.
        .onChange(of: intervalFocused) { wasFocused, isFocused in
            if wasFocused && !isFocused { commitTextFields() }
        }
        .onDisappear { commitTextFields() }
    }

    /// Grouped `.menu` picker over `model.models`; selecting a row sets both
    /// `modelInstanceID` and `modelID` and saves immediately.
    @ViewBuilder
    private func modelPairPicker(_ settings: AppSettings) -> some View {
        let options = model.models
        let currentPairID =
            "\((draft ?? settings).autoReview.modelInstanceID)/\((draft ?? settings).autoReview.modelID)"
        SettingsPickerRow(
            "Model",
            selection: Binding(
                get: { currentPairID },
                set: { pairID in
                    guard let option = options.first(where: { $0.id == pairID }) else { return }
                    var next = draft ?? settings
                    next.autoReview.modelInstanceID = option.instanceID
                    next.autoReview.modelID = option.modelID
                    draft = next
                    Task {
                        if await model.saveSettings(next) == false { rollbackDraft() }
                    }
                })
        ) {
            // Keep the current selection visible (and selectable) even when it
            // no longer resolves to an enabled provider instance.
            if !options.contains(where: { $0.id == currentPairID }) {
                Text("\(currentPairID) (unavailable)")
                    .tag(currentPairID)
            }
            ForEach(groupedModelOptions(options), id: \.kind) { group in
                Section(group.kind.displayName) {
                    ForEach(group.options) { option in
                        Text(optionLabel(option, in: group.options))
                            .tag(option.id)
                    }
                }
            }
        }
        .disabled(!settings.autoReview.enabled)
    }

    /// Models grouped by provider kind, preserving first-appearance order.
    private func groupedModelOptions(
        _ options: [ModelOption]
    ) -> [(kind: ProviderKind, options: [ModelOption])] {
        var order: [ProviderKind] = []
        var byKind: [ProviderKind: [ModelOption]] = [:]
        for option in options {
            if byKind[option.provider] == nil {
                order.append(option.provider)
            }
            byKind[option.provider, default: []].append(option)
        }
        return order.map { kind in (kind, byKind[kind] ?? []) }
    }

    /// `displayName` + `modelID`; appends the instance id only when several
    /// instances of the same provider kind offer models.
    private func optionLabel(_ option: ModelOption, in group: [ModelOption]) -> String {
        var label = "\(option.displayName) (\(option.modelID))"
        if Set(group.map(\.instanceID)).count > 1 {
            label += " — \(option.instanceID)"
        }
        return label
    }

    @ViewBuilder
    private func projectOverrideRow(
        _ settings: AppSettings, index: Int, override: AppAutoReviewProjectOverride
    ) -> some View {
        SettingsCardRow {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(override.projectTitle)
                        .font(.callout)
                    Text(override.projectID)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer()
                Picker(
                    "Enabled",
                    selection: Binding(
                        get: {
                            let current =
                                (draft ?? settings).autoReview.projectOverrides[safe: index]?.enabled
                            if current == nil { return "inherit" as String }
                            return current == true ? "on" : "off"
                        },
                        set: { choice in
                            var next = draft ?? settings
                            guard next.autoReview.projectOverrides.indices.contains(index) else {
                                return
                            }
                            switch choice {
                            case "on": next.autoReview.projectOverrides[index].enabled = true
                            case "off": next.autoReview.projectOverrides[index].enabled = false
                            default: next.autoReview.projectOverrides[index].enabled = nil
                            }
                            draft = next
                            Task {
                                if await model.saveSettings(next) == false { rollbackDraft() }
                            }
                        })
                ) {
                    Text("Inherit").tag("inherit")
                    Text("On").tag("on")
                    Text("Off").tag("off")
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .fixedSize()
                .disabled(!settings.autoReview.enabled)
            }
        }
    }

    @ViewBuilder
    private func jobRow(_ job: AppAutoReviewJob) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("PR #\(job.prNumber)")
                    .fontWeight(.medium)
                Text(job.status)
                    .font(.caption)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(statusColor(job.status).opacity(0.15), in: Capsule())
                    .foregroundStyle(statusColor(job.status))
                Spacer()
                Text(job.headSha.prefix(7))
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: 8) {
                Text(job.trigger)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("attempt \(job.attempt)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let count = job.findingsCount {
                    Text("\(count) findings")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if job.autoFixEnqueued {
                    Text("auto-fix queued")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            if let error = job.error, !error.isEmpty {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .lineLimit(3)
                    .textSelection(.enabled)
                    .help(error)
            }
            if let url = job.reviewURL, let link = URL(string: url) {
                Link("Open review", destination: link)
                    .font(.caption)
            }
        }
        .padding(.horizontal, 13)
        .padding(.vertical, 7)
    }

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "succeeded": .green
        case "running", "queued": .orange
        case "failed": .red
        case "skipped": .secondary
        default: .secondary
        }
    }

    private func binding<Value>(
        _ current: AppSettings, _ keyPath: WritableKeyPath<AppSettings, Value>
    ) -> Binding<Value> {
        Binding(
            get: { (draft ?? current)[keyPath: keyPath] },
            set: { newValue in
                var next = draft ?? current
                next[keyPath: keyPath] = newValue
                draft = next
                // A rejected save must not leave the toggle showing a value the
                // server never accepted.
                Task {
                    if await model.saveSettings(next) == false { rollbackDraft() }
                }
            })
    }

    private func textBinding(
        _ current: AppSettings, _ keyPath: WritableKeyPath<AppSettings, String>
    ) -> Binding<String> {
        Binding(
            get: { (draft ?? current)[keyPath: keyPath] },
            set: { newValue in
                var next = draft ?? current
                next[keyPath: keyPath] = newValue
                draft = next
            })
    }

    private func commitTextFields() {
        guard let pending = draft else { return }
        Task {
            if await model.saveSettings(pending) == false { rollbackDraft() }
        }
    }

    /// `loadSettings()` swallows its throw into the global `lastError` and
    /// leaves `settings` untouched, so a still-nil `settings` afterwards is
    /// the only signal that the load failed — without it the tab would sit on
    /// an indeterminate spinner forever.
    private func loadDraft() async {
        loadError = nil
        await model.loadSettings()
        guard var settings = model.settings else {
            loadError = model.lastError ?? "The server did not return settings."
            return
        }
        // Merge live project list so overrides include all known projects.
        settings.autoReview.projectOverrides = mergeProjectOverrides(
            existing: settings.autoReview.projectOverrides,
            projects: model.projects)
        draft = settings
    }

    /// Discards an optimistic edit the server rejected. Re-applies the
    /// project-override merge `loadDraft` does: assigning `model.settings`
    /// raw would drop every project the server has no stored override for,
    /// emptying the Projects list until the tab is reopened.
    private func rollbackDraft() {
        guard var settings = model.settings else { return }
        settings.autoReview.projectOverrides = mergeProjectOverrides(
            existing: settings.autoReview.projectOverrides,
            projects: model.projects)
        draft = settings
    }

    private func refreshJobs() async {
        isRefreshingJobs = true
        await model.refreshAutoReviewJobs()
        jobs = model.autoReviewJobs
        isRefreshingJobs = false
    }

    private func mergeProjectOverrides(
        existing: [AppAutoReviewProjectOverride], projects: [Project]
    ) -> [AppAutoReviewProjectOverride] {
        var byID = Dictionary(uniqueKeysWithValues: existing.map { ($0.projectID, $0) })
        for project in projects {
            if byID[project.id] == nil {
                byID[project.id] = AppAutoReviewProjectOverride(
                    projectID: project.id, projectTitle: project.name, enabled: nil)
            } else if var row = byID[project.id] {
                row.projectTitle = project.name
                byID[project.id] = row
            }
        }
        return byID.values.sorted {
            $0.projectTitle.localizedCaseInsensitiveCompare($1.projectTitle) == .orderedAscending
        }
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
