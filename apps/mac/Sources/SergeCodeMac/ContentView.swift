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
            SidebarView(multi: multi, scenery: scenery)
                .navigationSplitViewColumnWidth(min: 230, ideal: 280, max: 360)
        } detail: {
            Group {
                if let thread = multi.selectedThread {
                    ThreadDetailView(model: multi.activeModel, scenery: scenery, thread: thread)
                        .transition(.opacity)
                } else {
                    EmptyStateView(
                        scenery: scenery,
                        onQuickChat: { startQuickChat() },
                        onNewSession: { showNewSessionSheet = true })
                    .transition(.opacity)
                }
            }
            // Keyed to presence, not thread id — thread → thread switches
            // cross-fade inside ChatScreen; this only covers hero ↔ chat.
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
        // The stock AppKit sidebar toggle renders larger than the custom
        // 28×28 glass controls it sits next to; replace it with one of ours
        // (the View ▸ Toggle Sidebar menu item is unaffected).
        .toolbar(removing: .sidebarToggle)
        .toolbar {
            ToolbarItem(placement: .navigation) {
                Button {
                    // Same one-runloop deferral as the Inspector button below:
                    // re-vending toolbar items mid layout pass trips AppKit's
                    // layout-feedback-loop guard on macOS 26/27.
                    DispatchQueue.main.async {
                        withAnimation(Motion.structure) {
                            columnVisibility =
                                columnVisibility == .detailOnly ? .all : .detailOnly
                        }
                    }
                } label: {
                    Label("Toggle Sidebar", systemImage: "sidebar.leading")
                }
                .buttonStyle(AlpineToolbarIconButtonStyle())
            }
            .sharedBackgroundVisibility(.hidden)
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
                                    .disabled(!model.canCreateThread(with: provider))
                                }
                            }
                        }
                    }
                    .padding(8)
                }
            }
        }
    }

    private var selectedProject: Project? {
        guard let thread = multi.selectedThread else { return nil }
        return model.projects.first { $0.id == thread.projectID }
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
