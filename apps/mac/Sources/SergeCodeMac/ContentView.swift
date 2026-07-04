import SwiftUI

struct ContentView: View {
    @UIState private var selection: String?

    var body: some View {
        NavigationSplitView {
            List(selection: $selection) {
                Section("Sessions") {
                    Label("No sessions yet", systemImage: "tray")
                        .foregroundStyle(.secondary)
                }
            }
            .navigationSplitViewColumnWidth(min: 220, ideal: 260)
        } detail: {
            VStack(spacing: 16) {
                Image(systemName: "sparkles")
                    .font(.system(size: 44))
                    .foregroundStyle(.tint)
                Text("SergeCode")
                    .font(.largeTitle.bold())
                Text("Native macOS client — Liquid Glass scaffold")
                    .foregroundStyle(.secondary)
                Button("New Session") {}
                    .buttonStyle(.glass)
                    .controlSize(.large)
            }
            .padding(32)
            .glassEffect(.regular, in: .rect(cornerRadius: 24))
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                } label: {
                    Label("New Session", systemImage: "plus")
                }
            }
        }
    }
}

struct SettingsView: View {
    var body: some View {
        Form {
            Text("Settings placeholder")
        }
        .padding(20)
        .frame(width: 420, height: 240)
    }
}
