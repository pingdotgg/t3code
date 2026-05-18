import SwiftUI

struct EnvironmentSidebarView: View {
    let environments: [MobileEnvironment]
    @Binding var selectedEnvironmentID: MobileEnvironment.ID?

    var body: some View {
        List(environments, selection: $selectedEnvironmentID) { environment in
            Label(environment.title, systemImage: environment.isConnected ? "desktopcomputer" : "wifi.slash")
                .badge(environment.isConnected ? "Online" : "Offline")
        }
        .navigationTitle("Servers")
        .overlay {
            if environments.isEmpty {
                ContentUnavailableView(
                    "No Servers",
                    systemImage: "desktopcomputer.trianglebadge.exclamationmark",
                    description: Text(MobileDesign.placeholderMessage)
                )
            }
        }
    }
}

#Preview {
    @Previewable @State var selectedEnvironmentID: MobileEnvironment.ID? = "environment-preview"

    NavigationStack {
        EnvironmentSidebarView(
            environments: MobilePreviewData.environments,
            selectedEnvironmentID: $selectedEnvironmentID
        )
    }
}
