import SwiftUI
import Observation

@MainActor
@Observable
final class FeatureWorkspaceActivity {
    var isActive = true
    var pendingCommand: FeatureWorkspaceKeyboardRequest?
}

struct FeatureWorkspaceKeyboardRequest: Equatable {
    let id = UUID()
    let command: FeatureKeyboardCommand
}

/// Top-level Chats, PRs, Usage, and Settings sections. The system TabView
/// picks the bottom bar or the vertical rail from the scene, so this view
/// never checks the device. Each tab keeps its own navigation state.
struct FeatureWorkspaceTabs: View {
    private enum Selection: Hashable {
        case chats, pullRequests, usage, settings
    }

    let model: FeatureRootModel
    private let navigationRequest: FeatureWorkspaceNavigationRequest?
    private let onNavigationRequestConsumed: @MainActor (UUID) -> Void

    @State private var selection = Selection.chats
    @State private var activity = FeatureWorkspaceActivity()
    @State private var fallbackKeyboard = FeatureKeyboardDispatcher()

    init(
        model: FeatureRootModel,
        navigationRequest: FeatureWorkspaceNavigationRequest? = nil,
        onNavigationRequestConsumed: @escaping @MainActor (UUID) -> Void = { _ in }
    ) {
        self.model = model
        self.navigationRequest = navigationRequest
        self.onNavigationRequestConsumed = onNavigationRequestConsumed
    }

    var body: some View {
        tabs
            .environment(activity)
            .featureKeyboardScope(
                id: "workspace-tabs", isActive: !activity.isActive,
                enabledCommands: [.commandPalette, .newTask], onCommand: forwardCommand
            )
            .environment(\.featureKeyboardDispatcher, fallbackKeyboard)
            .onAppear { fallbackKeyboard.presentPalette = { forwardCommand(.commandPalette) } }
            .onDisappear { fallbackKeyboard.presentPalette = nil }
            // Every external destination belongs to the workspace. It keeps
            // the request until it applies it and reports the id back.
            .onChange(of: navigationRequest?.id, initial: true) { _, id in
                if id != nil { select(.chats) }
            }
    }

    @ViewBuilder private var tabs: some View {
        if #available(iOS 18.0, *) {
            TabView(selection: tabSelection) {
                Tab("Chats", systemImage: "text.bubble", value: .chats) { chats }
                Tab("PRs", systemImage: "arrow.triangle.pull", value: .pullRequests) { pullRequests }
                Tab("Usage", systemImage: "chart.bar.xaxis", value: .usage) { usage }
                Tab("Settings", systemImage: "gearshape", value: .settings) { settings }
            }
        } else {
            TabView(selection: tabSelection) {
                chats
                    .tabItem { Label("Chats", systemImage: "text.bubble") }
                    .tag(Selection.chats)
                pullRequests
                    .tabItem { Label("PRs", systemImage: "arrow.triangle.pull") }
                    .tag(Selection.pullRequests)
                usage
                    .tabItem { Label("Usage", systemImage: "chart.bar.xaxis") }
                    .tag(Selection.usage)
                settings
                    .tabItem { Label("Settings", systemImage: "gearshape") }
                    .tag(Selection.settings)
            }
        }
    }

    private var tabSelection: Binding<Selection> {
        Binding(get: { selection }, set: { select($0) })
    }

    private func select(_ tab: Selection) {
        // Publish visibility before UIKit starts the old tab's disappearance.
        activity.isActive = tab == .chats
        selection = tab
    }

    private func forwardCommand(_ command: FeatureKeyboardCommand) {
        activity.pendingCommand = FeatureWorkspaceKeyboardRequest(command: command)
        select(.chats)
    }

    private var chats: some View {
        WorkspaceView(
            model: model,
            navigationRequest: navigationRequest,
            onNavigationRequestConsumed: onNavigationRequestConsumed
        )
    }

    // PullRequestsView and UsageView push and title themselves but own no stack.
    private var pullRequests: some View {
        NavigationStack { PullRequestsView(model: model) }
    }

    private var usage: some View {
        NavigationStack { UsageView(client: model.client) }
    }

    private var settings: some View {
        SettingsView(model: model, initialDestination: nil, showsCloseButton: false)
    }
}
