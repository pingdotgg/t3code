import DesignKit
import SwiftUI

/// 1:1 port of `SettingsRouteScreen.tsx` presented as an iPhone pageSheet (`SETTINGS_OPENS_AS_SHEET`).
struct SettingsRootSheet: View {
    @Bindable var store: CoreStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.connTheme) private var theme

    var body: some View {
        NavigationStack {
            List {
                Section("Connections") {
                    NavigationLink {
                        SettingsEnvironmentsDetailView(store: store)
                    } label: {
                        settingsRow(icon: "desktopcomputer", label: "Environments", value: String(store.linked.count + (store.isPaired ? 1 : 0)))
                    }
                }

                Section {
                    placeholderLink(icon: "gearshape", label: "General")
                    placeholderLink(icon: "paintbrush", label: "Appearance")
                    placeholderLink(icon: "bubble.left.and.bubble.right", label: "Chat")
                    placeholderLink(icon: "keyboard", label: "Keyboard")
                    placeholderLink(icon: "mic", label: "Voice")
                }

                Section("Agents") {
                    placeholderLink(icon: "person.crop.circle", label: "Providers")
                    placeholderLink(icon: "text.bubble", label: "Threads")
                    placeholderLink(icon: "clock", label: "Scheduled tasks")
                }

                Section("Code") {
                    placeholderLink(icon: "folder", label: "Projects")
                    placeholderLink(icon: "arrow.triangle.branch", label: "Source control & issues")
                    placeholderLink(icon: "square.on.square", label: "Worktrees")
                }

                Section {
                    placeholderLink(icon: "arrow.clockwise", label: "Maintenance")
                    placeholderLink(icon: "flask", label: "Labs")
                    placeholderLink(icon: "info.circle", label: "About")
                    placeholderLink(icon: "archivebox", label: "Archive")
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(theme.background.ignoresSafeArea())
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        dismiss()
                    } label: {
                        ConnIcon("xmark")
                    }
                    .accessibilityLabel("Close")
                    .accessibilityIdentifier("settings.closeButton")
                }
            }
        }
    }

    private func placeholderLink(icon: String, label: String) -> some View {
        NavigationLink {
            SettingsPlaceholderDetailView(title: label, icon: icon)
        } label: {
            settingsRow(icon: icon, label: label, value: nil)
        }
    }

    private func settingsRow(icon: String, label: String, value: String?) -> some View {
        HStack(spacing: 12) {
            ConnIcon(icon)
                .font(.system(size: 16))
                .foregroundStyle(theme.mutedForeground)
                .frame(width: 24)
            Text(label)
                .font(.system(size: 16))
                .foregroundStyle(theme.foreground)
            Spacer()
            if let value {
                Text(value)
                    .font(.system(size: 15))
                    .foregroundStyle(theme.mutedForeground)
            }
        }
    }
}

private struct SettingsEnvironmentsDetailView: View {
    @Bindable var store: CoreStore
    @Environment(\.connTheme) private var theme

    @State private var adding = false
    @State private var pairingURL = ""

    var body: some View {
        List {
            Section("Connected Environment") {
                if let serverURL = store.serverURL {
                    LabeledContent("Server", value: serverURL)
                }
                LabeledContent("Status") {
                    ConnectionStatusPill(status: store.status)
                }
                Button {
                    store.reconnect()
                } label: {
                    Label("Reconnect", systemImage: "arrow.clockwise")
                }
                Button(role: .destructive) {
                    store.disconnect()
                } label: {
                    Label("Disconnect", systemImage: "power")
                }
            }
            Section("Linked environments") {
                ForEach(store.linked.keys.sorted(), id: \.self) { id in
                    if let child = store.linked[id] {
                        LabeledContent(child.serverURL ?? id) { ConnectionStatusPill(status: child.status) }
                            .swipeActions {
                                Button("Disconnect", role: .destructive) { store.removeLinked(id) }
                            }
                    }
                }
                Button("Link environment") { pairingURL = ""; adding = true }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(theme.background.ignoresSafeArea())
        .alert("Link environment", isPresented: $adding) {
            TextField("Pairing URL", text: $pairingURL).textInputAutocapitalization(.never)
            Button("Cancel", role: .cancel) {}
            Button("Connect") { store.addLinked(pairingURL) }
        }
        .navigationTitle("Environments")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct SettingsPlaceholderDetailView: View {
    let title: String
    let icon: String
    @Environment(\.connTheme) private var theme

    var body: some View {
        VStack(spacing: 12) {
            ConnIcon(icon)
                .font(.system(size: 28, weight: .light))
                .foregroundStyle(theme.mutedForeground)
            Text(title)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(theme.foreground)
            Text("Coming in a later wave.")
                .font(.system(size: 14))
                .foregroundStyle(theme.mutedForeground)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(theme.background.ignoresSafeArea())
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }
}
