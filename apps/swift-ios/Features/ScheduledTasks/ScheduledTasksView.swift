import SwiftUI

public struct ScheduledTasksView: View {
    @Bindable private var root: FeatureRootModel
    @State private var environmentID = ""

    public init(model: FeatureRootModel) { root = model }

    public var body: some View {
        VStack(spacing: 0) {
            if let client = root.client as? any FeatureScheduledTaskManaging {
                if let environment = selectedEnvironment {
                    if environments.count > 1 {
                        Picker("Environment", selection: Binding(
                            get: { environment.id }, set: { environmentID = $0 }
                        )) {
                            ForEach(environments) { Text($0.name).tag($0.id) }
                        }
                        .pickerStyle(.menu)
                        .padding(.horizontal)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("scheduled-tasks-environment")
                    }
                    ScheduledTasksEnvironmentView(root: root, environment: environment, client: client)
                        .id(environment.id)
                } else {
                    ContentUnavailableView("No environments", systemImage: "server.rack",
                        description: Text("Enable an environment in Settings to manage scheduled tasks."))
                }
            } else {
                ContentUnavailableView("Scheduled tasks unavailable", systemImage: "calendar.badge.clock")
            }
        }
        .background(Color.black)
        .foregroundStyle(.white)
        .navigationTitle("Scheduled tasks")
        .navigationBarTitleDisplayMode(.inline)
        .t3NavigationChrome()
    }

    private var environments: [FeatureEnvironment] { root.snapshot.environments.filter(\.isEnabled) }
    private var selectedEnvironment: FeatureEnvironment? {
        environments.first { $0.id == environmentID } ?? environments.first { $0.isActive } ?? environments.first
    }
}

private struct ScheduledTaskEditorRoute: Identifiable {
    let id = UUID()
    let draft: FeatureScheduledTaskDraft
}

private struct ScheduledTasksEnvironmentView: View {
    @SwiftUI.Environment(\.scenePhase) private var scenePhase
    @Bindable var root: FeatureRootModel
    let environment: FeatureEnvironment
    let client: any FeatureScheduledTaskManaging
    @State private var model: FeatureScheduledTaskListModel
    @State private var projectFilter = ""
    @State private var editor: ScheduledTaskEditorRoute?
    @State private var deleting: ScheduledTask?
    @State private var retryID = UUID()

    private struct SubscriptionKey: Hashable {
        let active: Bool
        let connection: FeatureConnection.State?
        let retry: UUID
    }

    init(root: FeatureRootModel, environment: FeatureEnvironment, client: any FeatureScheduledTaskManaging) {
        self.root = root
        self.environment = environment
        self.client = client
        _model = State(initialValue: FeatureScheduledTaskListModel(environmentID: environment.id, client: client))
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if projects.count > 1 {
                    Picker("Project", selection: $projectFilter) {
                        Text("All projects").tag("")
                        ForEach(projects) { Text($0.name).tag($0.wireID ?? $0.id) }
                    }
                    .pickerStyle(.menu)
                    .padding(.bottom, 12)
                }
                if let error = model.loadError {
                    Text(error).foregroundStyle(model.isUnsupported ? Color.secondary : .red)
                    Button("Retry") { retryID = UUID() }.padding(.vertical, 12)
                }
                if let tasks = model.tasks {
                    if tasks.isEmpty {
                        Text("No scheduled tasks").padding(.vertical, 24)
                    } else if filteredTasks.isEmpty {
                        Text("No scheduled tasks in this project").padding(.vertical, 24)
                    }
                    ForEach(filteredTasks) { task in
                        row(task)
                        Divider().overlay(Color.white.opacity(0.15))
                    }
                    if !model.receivesLiveUpdates && model.loadError == nil {
                        Text("Pull to refresh task status.")
                            .font(.footnote).foregroundStyle(.secondary).padding(.top, 16)
                    }
                } else if model.loadError == nil {
                    Text("Loading scheduled tasks…").padding(.vertical, 24)
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
        }
        .refreshable { await model.refresh() }
        .onChange(of: projects.map { $0.wireID ?? $0.id }) {
            if !projects.contains(where: { ($0.wireID ?? $0.id) == projectFilter }) { projectFilter = "" }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("New task", systemImage: "plus") { showEditor() }
                    .disabled(projects.isEmpty || model.tasks == nil || model.isUnsupported || !canManage)
                    .accessibilityIdentifier("scheduled-tasks-create")
            }
        }
        .task(id: SubscriptionKey(active: scenePhase == .active, connection: environment.connectionState, retry: retryID)) {
            guard scenePhase == .active else { return }
            await model.observe()
        }
        .sheet(item: $editor) { route in
            ScheduledTaskEditorView(root: root, environmentID: environment.id, initialDraft: route.draft,
                listModel: model, client: client)
        }
        .confirmationDialog("Delete scheduled task?", isPresented: Binding(
            get: { deleting != nil }, set: { if !$0 { deleting = nil } }
        ), titleVisibility: .visible) {
            if let task = deleting {
                Button("Delete task", role: .destructive) {
                    deleting = nil
                    Task { await model.delete(task) }
                }
            }
        } message: {
            Text("Future runs will stop. Existing threads will remain.")
        }
        .alert("Could not update task", isPresented: Binding(
            get: { model.actionError != nil }, set: { if !$0 { model.actionError = nil } }
        )) {
            Button("OK") { model.actionError = nil }
        } message: { Text(model.actionError ?? "") }
    }

    private var projects: [FeatureProject] { root.snapshot.projects.filter { $0.environmentID == environment.id } }
    private var filteredTasks: [ScheduledTask] {
        (model.tasks ?? []).filter { projectFilter.isEmpty || $0.projectId == projectFilter }
    }
    private var canManage: Bool {
        environment.isEnabled && environment.connectionState != .disconnected && environment.connectionState != .needsPairing
            && environment.permissions?.grants("orchestration:operate") == true
    }

    private func row(_ task: ScheduledTask) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Button { showEditor(task) } label: {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(task.title).font(.headline)
                        if !task.enabled { Text("Paused").font(.caption).foregroundStyle(.secondary) }
                        if task.lastRunStatus == .running { Text("Running").font(.caption) }
                    }
                    Text(task.prompt).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                    Text(projectName(task.projectId) + " · " + task.schedule.summary)
                        .font(.caption).foregroundStyle(.secondary)
                    if task.threadId != nil {
                        Text("Runs in an existing thread").font(.caption).foregroundStyle(.secondary)
                    }
                    if task.enabled, let next = task.nextRunAt.flatMap({ NativeTimestampParser.parse($0) }) {
                        Text("Next: \(next.formatted(date: .abbreviated, time: .shortened))").font(.caption)
                    }
                    if let last = task.lastRunAt.flatMap({ NativeTimestampParser.parse($0) }) {
                        Text("Last: \(last.formatted(date: .abbreviated, time: .shortened)) · \(statusLabel(task.lastRunStatus))")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if let error = task.lastRunError, !error.isEmpty {
                        Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Menu {
                Button("Edit", systemImage: "pencil") { showEditor(task) }
                Button(task.enabled ? "Pause" : "Resume", systemImage: task.enabled ? "pause" : "play") {
                    Task { await model.setEnabled(task, enabled: !task.enabled) }
                }
                if !task.schedule.isWebhook {
                    Button("Run now", systemImage: "play.fill") { Task { await model.runNow(task) } }
                        .disabled(task.lastRunStatus == .running)
                }
                Button(role: .destructive) { deleting = task } label: { Label("Delete", systemImage: "trash") }
            } label: {
                Image(systemName: "ellipsis").frame(width: 44, height: 44)
            }
            .accessibilityLabel("Actions for \(task.title)")
            .disabled(model.pendingIDs.contains(task.id) || !canManage)
        }
        .padding(.vertical, 16)
    }

    private func projectName(_ wireID: String) -> String {
        projects.first { ($0.wireID ?? $0.id) == wireID }?.name ?? "Project unavailable"
    }

    private func showEditor(_ task: ScheduledTask? = nil) {
        let project = task.flatMap { task in projects.first { ($0.wireID ?? $0.id) == task.projectId } }
            ?? (task == nil ? projects.first { ($0.wireID ?? $0.id) == projectFilter } ?? projects.first : nil)
        let selection = DailyUXCreationContext.initialSelection(for: project, in: root.snapshot)
        editor = .init(draft: .init(environmentID: environment.id, task: task, project: project, selection: selection))
    }

    private func statusLabel(_ status: ScheduledTaskRunStatus) -> String {
        switch status {
        case .never: "Not run"
        case .running: "Running"
        case .succeeded: "Succeeded"
        case .failed: "Failed"
        }
    }
}
