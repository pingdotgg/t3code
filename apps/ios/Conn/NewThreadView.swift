import DesignKit
import SwiftUI

struct NewThreadView: View {
    @Bindable var store: CoreStore
    let onCreated: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.connTheme) private var theme
    @State private var selectedProjectId: String? = nil // nil == General
    @State private var prompt = ""
    @State private var isLaunching = false

    private var projects: [FfiProject] {
        store.shell?.projects ?? []
    }

    private var canLaunch: Bool {
        !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isLaunching
    }

    var body: some View {
        NavigationStack {
            List {
                if let error = store.lastError, !error.isEmpty {
                    Section {
                        KitNotice(error, icon: .warning, tone: .error)
                    }
                }

                Section("Destination") {
                    projectRow(
                        id: nil,
                        title: "General",
                        subtitle: "Project-unbound scratch thread",
                        icon: "sparkles"
                    )
                    .accessibilityIdentifier("newThread.project.general")

                    ForEach(projects, id: \.id) { project in
                        projectRow(
                            id: project.id,
                            title: project.title.isEmpty ? project.id : project.title,
                            subtitle: project.workspaceRoot,
                            icon: "folder"
                        )
                        .accessibilityIdentifier("newThread.project.\(project.id)")
                    }
                }

                Section("Prompt") {
                    TextField("What should the agent work on?", text: $prompt, axis: .vertical)
                        .font(.kitBody)
                        .lineLimit(3...8)
                        .accessibilityIdentifier("newThread.promptField")
                }

                // TODO(wave3): model picker & branch/worktree selector
            }
            .navigationTitle("New Thread")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        launch()
                    } label: {
                        if isLaunching {
                            ProgressView()
                        } else {
                            Text("Start")
                                .fontWeight(.semibold)
                        }
                    }
                    .disabled(!canLaunch)
                    .accessibilityIdentifier("newThread.startButton")
                }
            }
        }
    }

    private func projectRow(id: String?, title: String, subtitle: String?, icon: String) -> some View {
        let isSelected = selectedProjectId == id
        return Button {
            selectedProjectId = id
        } label: {
            HStack(spacing: Kit.Space.m) {
                Image(systemName: icon)
                    .font(.system(size: 15))
                    .foregroundStyle(isSelected ? theme.primary : theme.mutedForeground)
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.kitBody)
                        .foregroundStyle(theme.foreground)
                    if let subtitle, !subtitle.isEmpty {
                        Text(subtitle)
                            .font(.kitDetail)
                            .foregroundStyle(theme.mutedForeground)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                Spacer()
                if isSelected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(theme.primary)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
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
                dismiss()
                onCreated(threadId)
            }
        }
    }
}
