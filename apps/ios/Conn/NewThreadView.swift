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
        onCreated: @escaping (String) -> Void
    ) {
        self.store = store
        self.onCreated = onCreated
        self._selectedProjectId = State(initialValue: initialProjectId)
        self._selectedProjectTitle = State(initialValue: initialProjectTitle)
    }

    private var environmentLabel: String {
        if let url = store.serverURL, let host = URL(string: url)?.host {
            return host == "127.0.0.1" ? "conn-gpui-dev" : host
        }
        return "conn-gpui-dev"
    }

    /// Mobile's `text-2xl font-t3-medium tracking-tight`: 26pt, weight 500, -0.025em.
    private static let heroFont = Font.system(size: 26, weight: .medium)
    private static let heroTracking: CGFloat = -0.65
    /// One space in the hero font, including its tracking.
    private static let heroSpaceWidth: CGFloat =
        (" " as NSString).size(withAttributes: [.font: UIFont.systemFont(ofSize: 26, weight: .medium)]).width
        + heroTracking

    private var canLaunch: Bool {
        !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isLaunching
    }

    var body: some View {
        VStack(spacing: 0) {
            // NewTaskDraftScreen.tsx splits the free space 1:2 around the hero
            // (`flexGrow: 1` above, `flexGrow: 2` below).
            Spacer()

            // Hero: "What should we build in <project>?"; the project has a 1pt muted bottom border.
            VStack(spacing: 24) {
                VStack(spacing: 6) {
                    Text("What should we build")
                        .font(Self.heroFont)
                        .tracking(Self.heroTracking)
                        .foregroundStyle(theme.foreground)
                    HStack(spacing: 0) {
                        // SwiftUI drops a trailing space in `Text`, so the space after "in" is padding.
                        Text("in")
                            .font(Self.heroFont)
                            .tracking(Self.heroTracking)
                            .foregroundStyle(theme.foreground)
                            .padding(.trailing, Self.heroSpaceWidth)
                        Button {
                            showingProjectPicker = true
                        } label: {
                            // `max-w-[250px] border-b border-foreground-muted`
                            CappedWidth(maxWidth: 250) {
                                Text(selectedProjectTitle)
                                    .font(Self.heroFont)
                                    .tracking(Self.heroTracking)
                                    .foregroundStyle(theme.foreground)
                                    .lineLimit(1)
                                    .padding(.bottom, 1)
                                    .overlay(alignment: .bottom) {
                                        Rectangle()
                                            .fill(theme.mutedForeground)
                                            .frame(height: 1)
                                    }
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("newThread.projectPickerButton")
                        Text("?")
                            .font(Self.heroFont)
                            .tracking(Self.heroTracking)
                            .foregroundStyle(theme.foreground)
                    }
                }
                .multilineTextAlignment(.center)

                // DraftEnvironmentControl: "on <environment> ›"
                HStack(spacing: 6) {
                    ConnIcon("server.rack")
                        .font(.system(size: 13))
                        .foregroundStyle(theme.mutedForeground)
                    Text("on \(environmentLabel)")
                        .font(.system(size: 14))
                        .foregroundStyle(theme.mutedForeground)
                        .lineLimit(1)
                    ConnIcon("chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(theme.mutedForeground)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            .padding(.horizontal, 24)

            Spacer()
            Spacer()

            if let error = store.lastError, !error.isEmpty {
                KitNotice(error, icon: .warning, tone: .error)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(theme.background.ignoresSafeArea())
        .kitComposerBar {
            VStack(alignment: .leading, spacing: 8) {
                // Workspace & branch context row above composer ("Current checkout · main ›")
                if selectedProjectId != nil {
                    HStack(spacing: 14) {
                        HStack(spacing: 5) {
                            ConnIcon("folder")
                                .font(.system(size: 13))
                                .foregroundStyle(theme.mutedForeground)
                            Text("Current checkout")
                                .font(.system(size: 13))
                                .foregroundStyle(theme.mutedForeground)
                        }
                        HStack(spacing: 5) {
                            ConnIcon("arrow.triangle.branch")
                                .font(.system(size: 13))
                                .foregroundStyle(theme.mutedForeground)
                            Text("main")
                                .font(.system(size: 13))
                                .foregroundStyle(theme.mutedForeground)
                            ConnIcon("chevron.right")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(theme.mutedForeground)
                        }
                        Spacer()
                    }
                    .padding(.horizontal, 4)
                }

                KitComposer(
                    "Ask anything",
                    text: $prompt,
                    maxLines: 6,
                    isBusy: isLaunching,
                    canSend: canLaunch,
                    onSend: launch,
                    onStop: {},
                    leading: {
                        ConnIcon("plus")
                            .font(.system(size: 16, weight: .medium))
                            .foregroundStyle(theme.mutedForeground)
                            .frame(width: 28, height: 28)
                    },
                    trailing: {
                        HStack(spacing: 3) {
                            Image(systemName: "sparkle")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(Color(red: 0.85, green: 0.47, blue: 0.34))
                            Image(systemName: "chevron.down")
                                .font(.system(size: 9, weight: .semibold))
                                .foregroundStyle(theme.mutedForeground)
                        }
                        .padding(.trailing, 4)
                    }
                )
                .accessibilityIdentifier("newThread.promptField")
            }
        }
        .navigationTitle("New thread")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                    } label: {
                        Label("Git controls", systemImage: "point.topleft.down.curvedto.point.bottomright.up")
                    }
                    Button {
                    } label: {
                        Label("Open files", systemImage: "folder")
                    }
                } label: {
                    Image(systemName: "ellipsis")
                }
                .accessibilityLabel("More actions")
            }
        }
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

/// Caps its child's width like CSS `max-width`, without growing to the cap the way
/// `.frame(maxWidth:)` does.
private struct CappedWidth: Layout {
    let maxWidth: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = min(proposal.width ?? maxWidth, maxWidth)
        return subviews.first?.sizeThatFits(ProposedViewSize(width: width, height: proposal.height)) ?? .zero
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
    }
}
