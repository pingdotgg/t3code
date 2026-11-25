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
