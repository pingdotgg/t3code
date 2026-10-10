import SwiftUI
import UIKit

struct ScheduledTaskEditorView: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @Bindable var root: FeatureRootModel
    let environmentID: String
    let initialDraft: FeatureScheduledTaskDraft
    @Bindable var listModel: FeatureScheduledTaskListModel
    let client: any FeatureScheduledTaskManaging
    @State private var draft: FeatureScheduledTaskDraft
    @State private var saving = false
    @State private var confirmRotation = false
    @State private var cloudState: EnvironmentCloudLinkState?
    @State private var saveError: String?
    @State private var confirmDiscard = false
    @State private var isPickingModel = false
    @State private var modelSelectionIsExplicit: Bool

    init(root: FeatureRootModel, environmentID: String, initialDraft: FeatureScheduledTaskDraft,
         listModel: FeatureScheduledTaskListModel, client: any FeatureScheduledTaskManaging) {
        self.root = root
        self.environmentID = environmentID
        self.initialDraft = initialDraft
        self.listModel = listModel
        self.client = client
        _draft = State(initialValue: initialDraft)
        _modelSelectionIsExplicit = State(initialValue: initialDraft.original != nil)
    }

    var body: some View {
        NavigationStack {
            Form {
                if taskMissing {
                    Text("This task no longer exists.").foregroundStyle(.red).listRowBackground(Color.black)
                }
                if environmentUnavailable {
                    Text("This environment is disconnected. Reconnect before saving.")
                        .foregroundStyle(.red).listRowBackground(Color.black)
                }
                taskSection
                scheduleSection
                if draft.scheduleMode == .webhook { webhookSection }
                workspaceSection
                executionSection
            }
            .disabled(saving)
            .scrollContentBackground(.hidden)
            .background(Color.black)
            .foregroundStyle(.white)
            .navigationTitle(initialDraft.original == nil ? "New scheduled task" : "Edit scheduled task")
            .navigationBarTitleDisplayMode(.inline)
            .t3NavigationChrome()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        if draft != initialDraft { confirmDiscard = true } else { dismiss() }
                    }
                    .disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Save") { Task { await save() } }
                        .disabled(saving || taskMissing || environmentUnavailable || !canManage)
                        .accessibilityIdentifier("scheduled-task-save")
                }
            }
            .task(id: environmentID) {
                guard let cloudClient = root.client as? any FeatureCloudPreferencesManaging else { return }
                cloudState = try? await cloudClient.cloudLinkState(environmentID: environmentID)
            }
            .onChange(of: draft.scheduleMode) {
                if draft.scheduleMode == .webhook, draft.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    draft.prompt = "Handle this webhook:\n{{body}}"
                }
            }
            .confirmationDialog("Rotate webhook URL?", isPresented: $confirmRotation, titleVisibility: .visible) {
                Button("Rotate URL", role: .destructive) {
                    guard canManage, let task = liveTask else { return }
                    Task { await listModel.rotateWebhookToken(task) }
                }
            } message: { Text("The current URL will stop working. Update the sender with the new URL.") }
            .onChange(of: draft.projectID) {
                guard initialDraft.original == nil else { return }
                draft.selection = DailyUXCreationContext.selection(
                    carrying: modelSelectionIsExplicit ? draft.selection : nil, to: selectedProject, in: root.snapshot
                )
            }
            .confirmationDialog("Discard changes?", isPresented: $confirmDiscard, titleVisibility: .visible) {
                Button("Discard changes", role: .destructive) { dismiss() }
            }
            .alert("Could not save task", isPresented: Binding(
                get: { saveError != nil }, set: { if !$0 { saveError = nil } }
            )) {
                Button("OK") { saveError = nil }
            } message: { Text(saveError ?? "") }
        }
        .presentationBackground(Color.black)
        .interactiveDismissDisabled(saving || draft != initialDraft)
    }

    private var taskSection: some View {
        Section {
            TextField("Name", text: $draft.title).accessibilityIdentifier("scheduled-task-title")
            TextField("Prompt", text: $draft.prompt, axis: .vertical)
                .lineLimit(4...12).accessibilityIdentifier("scheduled-task-prompt")
            Toggle("Enabled", isOn: $draft.enabled)
            Picker("Project", selection: $draft.projectID) {
                if !projects.contains(where: { $0.id == draft.projectID }) {
                    Text(draft.projectID.isEmpty ? "Choose project" : "Project unavailable").tag(draft.projectID)
                }
                ForEach(projects) { Text($0.name).tag($0.id) }
            }
            .disabled(draft.original?.threadId != nil)
            ProviderModelPicker(
                providers: providers,
                selection: Binding(get: { draft.selection }, set: {
                    // Catalog normalization must not rewrite a saved task just because its form opened.
                    guard isPickingModel else { return }
                    draft.selection = $0
                    modelSelectionIsExplicit = true
                }),
                materializesDefaultSelection: false, allowProviderSwitch: true,
                onRefresh: { _ = await root.refreshProviders(environmentID: environmentID) },
                onPresentationChange: { isPickingModel = $0 }
            )
            if let selection = draft.selection,
               !providers.contains(where: { provider in
                   provider.id == selection.providerID && provider.models.contains { $0.id == selection.modelID }
               }) {
                Text("Saved model: \(selection.modelID)").font(.footnote).foregroundStyle(.secondary)
            }
        }
        .listRowBackground(Color.black)
    }

    private var scheduleSection: some View {
        Section {
            Picker("Schedule", selection: $draft.scheduleMode) {
                Text("Fixed time").tag(FeatureScheduledTaskDraft.ScheduleMode.fixedTime)
                Text("Interval").tag(FeatureScheduledTaskDraft.ScheduleMode.interval)
                Text("On webhook").tag(FeatureScheduledTaskDraft.ScheduleMode.webhook)
            }
            if draft.scheduleMode == .interval {
                TextField("Every (minutes)", text: $draft.intervalMinutes)
                    .keyboardType(.decimalPad)
                    .accessibilityLabel("Interval in minutes")
            } else if draft.scheduleMode == .fixedTime {
                TextField("Time (HH:MM)", text: $draft.timeOfDay)
                    .keyboardType(.numbersAndPunctuation)
                    .accessibilityLabel("Time in the environment's time zone")
                HStack(spacing: 0) {
                    ForEach(0..<7) { day in
                        Button {
                            if draft.weekdays.contains(day) { draft.weekdays.remove(day) }
                            else { draft.weekdays.insert(day) }
                        } label: {
                            VStack(spacing: 4) {
                                Text(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day]).font(.caption)
                                Image(systemName: draft.weekdays.contains(day) ? "checkmark" : "minus")
                            }
                            .foregroundStyle(draft.weekdays.contains(day) ? Color.white : .secondary)
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityValue(draft.weekdays.contains(day) ? "Selected" : "Not selected")
                    }
                }
            }
        } footer: {
            Text(draft.scheduleMode == .fixedTime
                 ? "Uses the environment's local time zone."
                 : draft.scheduleMode == .interval ? "Runs at most once per minute." : "Runs when the webhook receives a request.")
        }
        .listRowBackground(Color.black)
    }

    private var webhookSection: some View {
        Section("Webhook") {
            Text("Use {{body.a.b}}, {{headers.name}}, {{query.name}}, {{body}}, or {{request}} in the prompt.")
                .font(.footnote).foregroundStyle(.secondary)
            TextField("Maximum delivery age (minutes)", text: $draft.maxDeliveryAgeMinutes)
                .keyboardType(.numberPad)
            Text("Leave empty to run every held request. Set 1–1440 minutes to skip older requests. Offline delivery is a separate T3 Connect setting.")
                .font(.footnote).foregroundStyle(.secondary)
            if let task = liveTask, task.schedule.isWebhook, let endpoint = task.webhook {
                let address = FeatureWebhookAddress(endpoint: endpoint, httpBaseURL: environment?.endpoint)
                Text(address.address).font(.footnote.monospaced()).textSelection(.enabled)
                if address.copyable {
                    Button("Copy URL", systemImage: "doc.on.doc") { UIPasteboard.general.string = address.address }
                }
                if let note = address.note { Text(note).font(.footnote).foregroundStyle(.secondary) }
                if endpoint.url != nil, let held = cloudState?.holdWebhooksWhileOffline {
                    Text(held ? "T3 Connect holds requests for up to 24 hours while offline."
                              : "Requests are delivered only while this environment is online.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if endpoint.hasSecret {
                    Text("Signature verification is enabled. Saving keeps the current signature settings and secret.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Button("Rotate URL", role: .destructive) { confirmRotation = true }
                    .disabled(!canManage || listModel.pendingIDs.contains(task.id))
            } else if initialDraft.original == nil {
                Text("Save the task to create its webhook URL.").font(.footnote).foregroundStyle(.secondary)
            }
            if let error = listModel.actionError { Text(error).font(.footnote).foregroundStyle(.red) }
        }
        .listRowBackground(Color.black)
    }

    private var workspaceSection: some View {
        Section("Workspace") {
            if draft.original?.threadId != nil {
                Text("Runs in its existing thread.").font(.footnote).foregroundStyle(.secondary)
            }
            Picker("Workspace", selection: $draft.workspace) {
                Text("New worktree").tag(FeatureScheduledTaskDraft.Workspace.worktree)
                Text("Project directory").tag(FeatureScheduledTaskDraft.Workspace.root)
                Text("Existing worktree").tag(FeatureScheduledTaskDraft.Workspace.existingWorktree)
            }
            if draft.workspace == .worktree {
                TextField("Base branch", text: $draft.baseRef)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                Toggle("Start from origin", isOn: Binding(
                    get: { draft.startFromOrigin ?? false }, set: { draft.startFromOrigin = $0 }
                ))
            }
            if draft.workspace == .existingWorktree {
                TextField("Worktree path", text: $draft.checkoutPath)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
            }
            TextField("Branch (optional)", text: $draft.branch)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
        }
        .listRowBackground(Color.black)
    }

    private var executionSection: some View {
        Section {
            Picker("Permissions", selection: $draft.runtimeMode) {
                Text("Supervised").tag(RuntimeMode.approvalRequired)
                Text("Auto-accept edits").tag(RuntimeMode.autoAcceptEdits)
                Text("Auto").tag(RuntimeMode.auto)
                Text("Full access").tag(RuntimeMode.fullAccess)
            }
            Picker("Mode", selection: $draft.interactionMode) {
                Text("Build").tag(InteractionMode.default)
                Text("Plan").tag(InteractionMode.plan)
            }
        }
        .listRowBackground(Color.black)
    }

    private var projects: [FeatureProject] { root.snapshot.projects.filter { $0.environmentID == environmentID } }
    private var selectedProject: FeatureProject? { projects.first { $0.id == draft.projectID } }
    private var providers: [FeatureProvider] {
        root.snapshot.providersByEnvironment?[environmentID]
            ?? DailyUXCreationContext.providers(for: selectedProject, in: root.snapshot)
    }
    private var environment: FeatureEnvironment? { root.snapshot.environments.first { $0.id == environmentID } }
    private var canManage: Bool {
        !environmentUnavailable && environment?.permissions?.grants("orchestration:operate") == true
    }
    private var liveTask: ScheduledTask? {
        initialDraft.original.flatMap { listModel.task(id: $0.id) }
    }
    private var taskMissing: Bool {
        guard let original = initialDraft.original, let tasks = listModel.tasks else { return false }
        return !tasks.contains { $0.id == original.id }
    }
    private var environmentUnavailable: Bool {
        guard let environment = root.snapshot.environments.first(where: { $0.id == environmentID }) else { return true }
        return !environment.isEnabled || environment.connectionState == .disconnected || environment.connectionState == .needsPairing
    }

    private func save() async {
        guard !saving, !taskMissing, !environmentUnavailable, canManage else { return }
        saving = true
        do {
            let input = try draft.input(projects: projects, latestTask: liveTask)
            _ = try await client.upsertScheduledTask(environmentID: environmentID, input: input)
            await listModel.refresh()
            dismiss()
        } catch {
            saving = false
            saveError = error.localizedDescription
        }
    }
}
