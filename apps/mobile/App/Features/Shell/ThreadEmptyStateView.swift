import SwiftUI

struct ThreadEmptyStateView: View {
    let connectionState: MobileConnectionState

    var body: some View {
        if connectionState == .notConfigured {
            MobileSetupInstructionsView()
        } else {
            ContentUnavailableView(
                "No Chat Selected",
                systemImage: "bubble.left.and.bubble.right",
                description: Text("Select a chat to inspect its cached transcript.")
            )
        }
    }
}

#Preview {
    ThreadEmptyStateView(connectionState: .notConfigured)
}
