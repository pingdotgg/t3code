import DesignKit
import SwiftUI

enum WorkspaceTab: Hashable {
    case threads
    case tasks
    case pullRequests
    case settings
}

struct WorkspaceRootView: View {
    @Bindable var store: CoreStore
    @State private var selectedTab: WorkspaceTab = .threads

    var body: some View {
        TabView(selection: $selectedTab) {
            Tab("Chats", systemImage: "text.bubble", value: .threads) {
                InboxView(store: store)
            }
            Tab("Tasks", systemImage: "checklist", value: .tasks) {
                PlaceholderTabView(
                    title: "Tasks",
                    symbol: "checklist",
                    subtitle: "Orbit Tasks will be wired in Wave 3."
                )
            }
            Tab("PRs", systemImage: "arrow.triangle.pull", value: .pullRequests) {
                PlaceholderTabView(
                    title: "Pull Requests",
                    symbol: "arrow.triangle.pull",
                    subtitle: "GitHub Pull Requests will be wired in a later wave."
                )
            }
            Tab("Settings", systemImage: "gearshape", value: .settings) {
                SettingsPlaceholderView(store: store)
            }
        }
    }
}

private struct PlaceholderTabView: View {
    let title: String
    let symbol: String
    let subtitle: String
    @Environment(\.connTheme) private var theme

    var body: some View {
        NavigationStack {
            VStack(spacing: Kit.Space.m) {
                Image(systemName: symbol)
                    .font(.system(size: 32, weight: .light))
                    .foregroundStyle(theme.mutedForeground)
                Text(title)
                    .font(.kitLabel.weight(.medium))
                    .foregroundStyle(theme.foreground)
                Text(subtitle)
                    .font(.kitDetail)
                    .foregroundStyle(theme.mutedForeground)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(theme.background.ignoresSafeArea())
            .navigationTitle(title)
        }
    }
}

struct SettingsPlaceholderView: View {
    @Bindable var store: CoreStore
    @Environment(\.connTheme) private var theme

    var body: some View {
        NavigationStack {
            List {
                Section("Connection") {
                    if let serverURL = store.serverURL {
                        LabeledContent("Server", value: serverURL)
                    }
                    LabeledContent("Status") {
                        ConnectionStatusPill(status: store.status)
                    }
                    Button {
                        store.reconnect()
                    } label: {
                        Label("Reconnect", systemImage: KitIcon.sync.symbol)
                    }
                    Button(role: .destructive) {
                        store.disconnect()
                    } label: {
                        Label("Disconnect", systemImage: KitIcon.power.symbol)
                    }
                }

                Section("Appearance") {
                    LabeledContent("Active Theme", value: theme.themeId)
                    Text("Theme sync with Orbit profiles and full settings will arrive in a later wave.")
                        .font(.kitDetail)
                        .foregroundStyle(theme.mutedForeground)
                }
            }
            .navigationTitle("Settings")
        }
    }
}

struct ConnectionStatusPill: View {
    let status: FfiConnectionStatus?

    var body: some View {
        switch status {
        case .connected:
            KitStatusPill("Connected", tone: .ok)
        case .connecting, .none:
            KitStatusPill("Connecting", tone: .working)
        case let .reconnecting(attempt):
            KitStatusPill("Reconnecting (\(attempt))", tone: .working)
        case .failed:
            KitStatusPill("Failed", tone: .error)
        }
    }
}
