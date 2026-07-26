import SwiftUI

// App shell. File kept as ContentView.swift for historical reasons but now
// hosts RootView, the top-level NavigationSplitView wired to AppModel.
struct RootView: View {
    let multi: MultiDeviceModel
    let scenery: SceneryStore

    @UIState private var showInspector = true
    @UIState private var showNewSessionSheet = false
    @UIState private var columnVisibility: NavigationSplitViewVisibility = .all

    private var model: AppModel { multi.activeModel }

    var body: some View {
        // Drag-collapse writes visibility through this binding; wrapping
        // the set animates the snap-closed instead of an instant jump.
        NavigationSplitView(columnVisibility: Binding(
            get: { columnVisibility },
            set: { newValue in
                withAnimation(Motion.structure) {
                    columnVisibility = newValue
                }
            }
        )) {
            SidebarView(multi: multi, scenery: scenery, onToggleSidebar: toggleSidebar)
                .navigationSplitViewColumnWidth(min: 230, ideal: 280, max: 360)
                // The stock AppKit sidebar toggle renders larger than the custom
                // 28×28 glass controls; the sidebar vends its own close button
                // instead. The removal must be applied to the view inside the
                // sidebar column to take effect (the View ▸ Toggle Sidebar menu
                // item is unaffected).
                .toolbar(removing: .sidebarToggle)
        } detail: {
            Group {
                if let thread = multi.selectedThread {
                    ThreadDetailView(model: multi.activeModel, scenery: scenery, thread: thread)
                        .transition(.opacity)
                } else {
                    EmptyStateView(
                        // Quick Chat always runs on the local model, so that's
                        // the `lastError` the hero has to be able to show.
                        model: multi.local,
                        scenery: scenery,
                        onQuickChat: { startQuickChat() },
                        onNewSession: { showNewSessionSheet = true })
                    .transition(.opacity)
                }
            }
            // Keyed to presence, not thread id — thread → thread switches render
            // immediately inside ChatScreen (frequent, often keyboard-driven); this
            // only covers hero ↔ chat.
            .animation(Motion.structure, value: multi.selectedThread == nil)
            // The inspector hangs off this stable node, not off the
            // per-thread detail view: re-presenting it on every thread
            // switch (and inside the cross-fade above) reset its column
            // width and flashed/clipped the panel.
            .inspector(isPresented: $showInspector) {
                Group {
                    if let thread = multi.selectedThread {
                        InspectorPanel(model: multi.activeModel, threadID: thread.id)
                    } else {
                        ContentUnavailableView(
                            "No Session",
                            systemImage: "sidebar.right",
                            description: Text("Select a session to inspect its changes."))
                    }
                }
                .inspectorColumnWidth(min: 300, ideal: 360, max: 480)
            }
        }
        // Let `WindowGlassBackground` show through chrome gaps / faded scenery
        // instead of an opaque split-view plate over the desktop glass.
        .toolbarBackgroundVisibility(.hidden, for: .windowToolbar)
        .toolbar {
            // Reopen affordance: the close button lives inside the
            // sidebar, so once the column is collapsed this is the only
            // on-screen way back (besides the View menu / shortcut and
            // edge-drag). The whole item is gated so no empty navigation
            // slot lingers while the sidebar is visible.
            if columnVisibility == .detailOnly {
                ToolbarItem(placement: .navigation) {
                    Button(action: toggleSidebar) {
                        Label("Show Sidebar", systemImage: "sidebar.leading")
                    }
                    .buttonStyle(AlpineToolbarIconButtonStyle())
                    .help("Show Sidebar")
                    .transition(.opacity)
                }
                .sharedBackgroundVisibility(.hidden)
            }
            ToolbarItem(placement: .navigation) {
                ConnectionStatusPill(phase: model.connection)
            }
            .sharedBackgroundVisibility(.hidden)
            ToolbarItem(placement: .primaryAction) {
                newSessionMenu
            }
            .sharedBackgroundVisibility(.hidden)
            ToolbarItem(placement: .primaryAction) {
                Button {
                    // Deferred one runloop turn: flipping this synchronously
                    // from a toolbar button can land while the window is mid
                    // layout pass, and on macOS 26/27 a SwiftUI toolbar
                    // re-vend during an in-layout render trips AppKit's
                    // layout-feedback-loop guard (NSInternalInconsistency in
                    // _postWindowNeedsUpdateConstraints → hard crash).
                    DispatchQueue.main.async { showInspector.toggle() }
                } label: {
                    Label("Inspector", systemImage: "sidebar.right")
                }
                .buttonStyle(AlpineToolbarIconButtonStyle())
                .disabled(model.selectedThread == nil)
            }
            .sharedBackgroundVisibility(.hidden)
        }
        .sheet(isPresented: $showNewSessionSheet) {
            NewSessionSheet(
                multi: multi,
                scenery: scenery,
                isPresented: $showNewSessionSheet)
        }
        // PR-merge celebration: full-window confetti + badge, non-interactive,
        // self-dismissing. Keyed to the celebration id so back-to-back merges
        // each get their own burst.
        .overlay {
            if let celebration = model.mergeCelebration {
                MergeCelebrationOverlay(celebration: celebration) {
                    model.clearMergeCelebration(id: celebration.id)
                }
                .id(celebration.id)
                .transition(.opacity)
            }
        }
        // Cross-fades the celebration in and (when its timer clears it) out,
        // so the confetti never hard-cuts on unmount.
        .animation(Motion.reveal, value: model.mergeCelebration)
    }

    /// Primary click opens the scalable chooser. The chevron's Alpine popover
    /// stays a genuinely quick path: Quick Chat, the full chooser, or repeat
    /// the current session's project/provider. It deliberately does not
    /// reproduce the full device × project × provider tree.
    @ViewBuilder
    private var newSessionMenu: some View {
        NewSessionSplitControl(onNewSession: { showNewSessionSheet = true }) { isPresented in
            ComposerPickerSurface(width: 320) {
                VStack(spacing: 0) {
                    ComposerPickerHeader(
                        icon: "plus",
                        title: "New session",
                        subtitle: "Start quickly, or repeat the current target")
                    Divider().opacity(0.55)
                    VStack(spacing: 3) {
                        AlpineMenuRow(
                            icon: "bubble.left.and.bubble.right",
                            title: "Quick Chat",
                            detail: "General session in \(GeneralWorkspace.relativePath)"
                        ) {
                            isPresented.wrappedValue = false
                            startQuickChat()
                        }
                        .disabled(!multi.local.capabilities.canBrowseLocalFolders)

                        AlpineMenuRow(
                            icon: "slider.horizontal.3",
                            title: "Choose Target…",
                            detail: "Pick a device, project, and provider"
                        ) {
                            isPresented.wrappedValue = false
                            // Defer one runloop turn so the sheet never races
                            // the popover dismissal.
                            DispatchQueue.main.async { showNewSessionSheet = true }
                        }

                        if let thread = multi.selectedThread, let project = selectedProject {
                            ComposerPickerSectionLabel(title: project.name)
                                .padding(.top, 4)

                            AlpineMenuRow(
                                title: "New \(thread.provider.displayName) Session",
                                detail: "Same project and provider as this session"
                            ) {
                                isPresented.wrappedValue = false
                                createSession(
                                    owner: model,
                                    projectID: project.id,
                                    provider: thread.provider,
                                    deviceID: model.deviceID)
                            } leading: {
                                ProviderIcon(
                                    provider: thread.provider,
                                    modelID: thread.modelID,
                                    size: 14)
                            }
                            .disabled(!canCreateSession(with: thread.provider))
                            .help(sessionRowHelp(for: thread.provider))

                            let otherProviders = model.configuredProviderKinds.filter {
                                $0 != thread.provider
                            }
                            if !otherProviders.isEmpty {
                                ComposerPickerSectionLabel(title: "Other providers")
                                ForEach(otherProviders) { provider in
                                    AlpineMenuRow(title: provider.displayName) {
                                        isPresented.wrappedValue = false
                                        createSession(
                                            owner: model,
                                            projectID: project.id,
                                            provider: provider,
                                            deviceID: model.deviceID)
                                    } leading: {
                                        ProviderIcon(provider: provider, size: 14)
                                    }
                                    .disabled(!canCreateSession(with: provider))
                                    .help(sessionRowHelp(for: provider))
                                }
                            }
                        }
                    }
                    .padding(8)
                }
            }
        }
    }

    /// Mirrors `createSession`'s own guards, so a row that would silently bail
    /// reads as disabled instead of dead. A remote device that isn't connected
    /// can't create anything, and neither can a provider that isn't runnable.
    private func canCreateSession(with provider: ProviderKind) -> Bool {
        guard model.deviceID == .local || model.connection == .ready else { return false }
        return model.canCreateThread(with: provider)
    }

    private func sessionRowHelp(for provider: ProviderKind) -> String {
        if model.deviceID != .local, model.connection != .ready {
            return "That Mac isn't connected right now."
        }
        if !model.canCreateThread(with: provider) {
            return "\(provider.displayName) isn't ready. Open Settings ▸ Providers and refresh."
        }
        return "Start another \(provider.displayName) session in this project"
    }

    private var selectedProject: Project? {
        guard let thread = multi.selectedThread else { return nil }
        return model.projects.first { $0.id == thread.projectID }
    }

    private func toggleSidebar() {
        // Deferred one runloop turn: flipping the visibility re-vends the
        // conditional "Show Sidebar" toolbar item, and on macOS 26/27 a
        // SwiftUI toolbar re-vend during an in-layout render trips AppKit's
        // layout-feedback-loop guard (same crash class as the Inspector
        // button above).
        DispatchQueue.main.async {
            withAnimation(Motion.structure) {
                columnVisibility = columnVisibility == .detailOnly ? .all : .detailOnly
            }
        }
    }

    private func startQuickChat() {
        Task {
            let owner = multi.local
            if let thread = await owner.startQuickChat(scenery: scenery) {
                multi.select(threadID: thread.id, on: .local)
            }
        }
    }

    private func createSession(
        owner: AppModel,
        projectID: String,
        provider: ProviderKind,
        deviceID: DeviceID
    ) {
        Task {
            guard owner.deviceID == .local || owner.connection == .ready else { return }
            if let thread = await owner.createSceneThread(
                projectID: projectID,
                provider: provider,
                scenery: scenery)
            {
                multi.select(threadID: thread.id, on: deviceID)
            }
        }
    }
}
