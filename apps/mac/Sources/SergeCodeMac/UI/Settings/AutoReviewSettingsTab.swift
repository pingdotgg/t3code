import SwiftUI
import T3Kit

/// Settings tab for the native auto-review system (SER-141).
struct AutoReviewSettingsTab: View {
    let model: AppModel
    @UIState private var draft: AppSettings?
    @UIState private var jobs: [AppAutoReviewJob] = []
    @UIState private var isRefreshingJobs = false
    @FocusState private var mentionFocused: Bool
    @FocusState private var modelInstanceFocused: Bool
    @FocusState private var modelIDFocused: Bool

    var body: some View {
        Form {
            if let settings = draft {
                Section {
                    Toggle("Enable auto-review", isOn: binding(settings, \.autoReview.enabled))
                    Text(
                        "When enabled, SurgeCode polls open GitHub PRs for your projects, posts a review with your selected model, and can auto-prompt the origin thread to fix blocking/important findings."
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                }

                Section("When to run") {
                    Picker("Mode", selection: binding(settings, \.autoReview.mode)) {
                        Text("Auto on open / push").tag("auto")
                        Text("Only when @mentioned").tag("mention")
                    }
                    .pickerStyle(.segmented)
                    .disabled(!settings.autoReview.enabled)

                    TextField(
                        "Mention handle",
                        text: textBinding(settings, \.autoReview.mentionHandle))
                        .focused($mentionFocused)
                        .disabled(!settings.autoReview.enabled || settings.autoReview.mode != "mention")
                        .help("GitHub comment trigger, without the @ (default: surgecode)")

                    Toggle(
                        "Auto-fix origin thread",
                        isOn: binding(settings, \.autoReview.autoFixOriginThread))
                        .disabled(!settings.autoReview.enabled)
                        .help(
                            "After a review with blocking/important findings, prompt the linked SurgeCode thread that opened the PR."
                        )
                }

                Section("Model") {
                    TextField(
                        "Provider instance ID",
                        text: textBinding(settings, \.autoReview.modelInstanceID))
                        .focused($modelInstanceFocused)
                        .disabled(!settings.autoReview.enabled)
                        .help("Configured provider instance, e.g. codex, claudeAgent, grok")
                    TextField(
                        "Model ID",
                        text: textBinding(settings, \.autoReview.modelID))
                        .focused($modelIDFocused)
                        .disabled(!settings.autoReview.enabled)
                    if !model.providers.isEmpty {
                        modelQuickPick(settings)
                    }
                }

                Section("Polling") {
                    HStack {
                        Text("Interval")
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
                            .frame(width: 72)
                            .multilineTextAlignment(.trailing)
                            .disabled(!settings.autoReview.enabled)
                        Text("sec")
                            .foregroundStyle(.secondary)
                    }
                    Text("Clamped to 15–600 seconds on the server.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if !settings.autoReview.projectOverrides.isEmpty {
                    Section("Projects") {
                        ForEach(
                            Array(settings.autoReview.projectOverrides.enumerated()),
                            id: \.element.id
                        ) { index, override in
                            projectOverrideRow(settings, index: index, override: override)
                        }
                    }
                }

                Section("Recent jobs") {
                    if isRefreshingJobs && jobs.isEmpty {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                    } else if jobs.isEmpty {
                        Text(
                            settings.autoReview.enabled
                                ? "No auto-review jobs yet. Open or update a PR on a project repo."
                                : "Enable auto-review to start polling."
                        )
                        .foregroundStyle(.secondary)
                    } else {
                        ForEach(jobs) { job in
                            jobRow(job)
                        }
                    }
                    Button("Refresh jobs") {
                        Task { await refreshJobs() }
                    }
                    .disabled(model.connection != .ready)
                }
            } else {
                Section {
                    if model.connection == .ready {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                    } else {
                        Text("Connect to the server to edit auto-review settings.")
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .padding()
        .animation(Motion.reveal, value: draft == nil)
        .task {
            await model.loadSettings()
            var loaded = model.settings
            // Merge live project list so overrides include all known projects.
            if var settings = loaded {
                settings.autoReview.projectOverrides = mergeProjectOverrides(
                    existing: settings.autoReview.projectOverrides,
                    projects: model.projects)
                draft = settings
            }
            await refreshJobs()
        }
        .onChange(of: mentionFocused) { wasFocused, isFocused in
            if wasFocused && !isFocused { commitTextFields() }
        }
        .onChange(of: modelInstanceFocused) { wasFocused, isFocused in
            if wasFocused && !isFocused { commitTextFields() }
        }
        .onChange(of: modelIDFocused) { wasFocused, isFocused in
            if wasFocused && !isFocused { commitTextFields() }
        }
        .onDisappear { commitTextFields() }
    }

    @ViewBuilder
    private func modelQuickPick(_ settings: AppSettings) -> some View {
        let instances = model.providers
        if !instances.isEmpty {
            Picker(
                "Quick pick instance",
                selection: Binding(
                    get: { (draft ?? settings).autoReview.modelInstanceID },
                    set: { newInstance in
                        var next = draft ?? settings
                        next.autoReview.modelInstanceID = newInstance
                        draft = next
                        Task { await model.saveSettings(next) }
                    })
            ) {
                ForEach(instances) { provider in
                    Text("\(provider.kind.displayName) (\(provider.id))")
                        .tag(provider.id)
                }
            }
            .disabled(!settings.autoReview.enabled)
        }
    }

    @ViewBuilder
    private func projectOverrideRow(
        _ settings: AppSettings, index: Int, override: AppAutoReviewProjectOverride
    ) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(override.projectTitle)
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
                        Task { await model.saveSettings(next) }
                    })
            ) {
                Text("Inherit").tag("inherit")
                Text("On").tag("on")
                Text("Off").tag("off")
            }
            .labelsHidden()
            .frame(width: 110)
            .disabled(!settings.autoReview.enabled)
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
                    .lineLimit(2)
            }
            if let url = job.reviewURL, let link = URL(string: url) {
                Link("Open review", destination: link)
                    .font(.caption)
            }
        }
        .padding(.vertical, 2)
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
                Task { await model.saveSettings(next) }
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
        guard let draft else { return }
        Task { await model.saveSettings(draft) }
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
