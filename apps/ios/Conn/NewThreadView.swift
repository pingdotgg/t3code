import DesignKit
import SwiftUI
import UIKit

/// 1:1 port of `NewTaskDraftScreen.tsx` + `DraftThreadHeader.tsx` + `DraftEnvironmentControl.tsx`.
/// Opened directly when tapping "+" in `WorkspacePhoneBar`.
struct NewThreadDraftView: View {
    @Bindable var store: CoreStore
    let onCreated: (String) -> Void

    @Environment(\.connTheme) private var theme
    @State private var selectedProjectId: String?
    @State private var selectedProjectTitle: String
    @State private var prompt = ""
    @State private var isLaunching = false
    @State private var showingProjectPicker = false

    init(
        store: CoreStore,
        initialProjectId: String?,
        initialProjectTitle: String,
        initialPrompt: String = "",
        onCreated: @escaping (String) -> Void
    ) {
        self.store = store
        self.onCreated = onCreated
        self._prompt = State(initialValue: initialPrompt)
        self._selectedProjectId = State(initialValue: initialProjectId)
        self._selectedProjectTitle = State(initialValue: initialProjectTitle)
    }

    private var canLaunch: Bool {
        !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isLaunching && store.status == .connected
    }

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            Text("What should we work on?")
                .font(.system(size: 26, weight: .medium))
                .tracking(-0.65)
                .multilineTextAlignment(.center)
            if selectedProjectId != nil {
                Button(selectedProjectTitle) { showingProjectPicker = true }
                    .accessibilityIdentifier("newThread.projectPickerButton")
            }
            Spacer()

            if let error = store.lastError, !error.isEmpty {
                KitNotice(error, icon: .warning, tone: .error)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(theme.background.ignoresSafeArea())
        // Draft mode of the thread screen: the same floating glass pill, no band behind it.
        .safeAreaBar(edge: .bottom, spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                if store.status != .connected { OfflinePill().frame(maxWidth: .infinity) }
                ConnComposerPill(
                    placeholder: "Ask anything",
                    text: $prompt,
                    isBusy: isLaunching,
                    canSend: canLaunch,
                    onSend: launch,
                    onStop: {},
                    // A new chat starts on the project's model; picking one needs a launch override.
                    trailing: { EmptyView() }
                )
                .accessibilityIdentifier("newThread.promptField")
            }
            .padding(.horizontal, 12)
            .padding(.top, 6)
            .padding(.bottom, 2)
        }
        .scrollEdgeEffectStyle(.soft, for: .bottom)
        .navigationTitle("New thread")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showingProjectPicker) {
            NewTaskProjectPickerView(
                store: store,
                selectedProjectId: selectedProjectId,
                onSelect: { id, title in
                    selectedProjectId = id
                    selectedProjectTitle = title
                    showingProjectPicker = false
                }
            )
        }
    }

    private func launch() {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isLaunching else { return }
        isLaunching = true
        Task {
            let threadId: String?
            if let projectId = selectedProjectId {
                threadId = await store.launchThread(projectId: projectId, text: text)
            } else {
                threadId = await store.launchGeneralThread(text: text)
            }
            isLaunching = false
            if let threadId {
                onCreated(threadId)
            }
        }
    }
}

/// 1:1 port of `NewTaskRouteScreen.tsx` (`NewTaskProject` picker opened from underlined project in draft).
struct NewTaskProjectPickerView: View {
    @Bindable var store: CoreStore
    let selectedProjectId: String?
    let onSelect: (String?, String) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.connTheme) private var theme
    @State private var searchText = ""

    private var projects: [FfiProject] {
        let all = (store.shell?.projects ?? []).filter { !isScratchProjectTitle($0.title) }
        let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return all }
        return all.filter {
            $0.title.lowercased().contains(q) || $0.workspaceRoot.lowercased().contains(q)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if searchText.isEmpty || "general".contains(searchText.lowercased()) {
                    projectRow(
                        id: nil,
                        title: "General",
                        subtitle: "Start a chat without a project"
                    )
                    .accessibilityIdentifier("newThread.project.general")
                }

                ForEach(projects, id: \.id) { project in
                    projectRow(
                        id: project.id,
                        title: project.title.isEmpty ? project.id : project.title,
                        subtitle: project.workspaceRoot
                    )
                    .accessibilityIdentifier("newThread.project.\(project.id)")
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(theme.background.ignoresSafeArea())
            .navigationTitle("Choose project")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $searchText, prompt: "Search projects")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .accessibilityLabel("Close")
                }
            }
        }
    }

    private func projectRow(id: String?, title: String, subtitle: String?) -> some View {
        Button {
            onSelect(id, title)
        } label: {
            HStack(spacing: 12) {
                ProjectFaviconView(title: id == nil ? nil : title, size: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(theme.foreground)
                        .lineLimit(1)
                    if let subtitle, !subtitle.isEmpty {
                        Text(subtitle)
                            .font(.system(size: 12))
                            .foregroundStyle(theme.mutedForeground)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                Spacer()
                if selectedProjectId == id {
                    ConnIcon("checkmark")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(theme.primary)
                }
            }
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(theme.background)
    }
}
