import SwiftUI

/// Glass empty-state hero shown as the detail column when no thread is
/// selected.
struct EmptyStateView: View {
    var onNewSession: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "sparkles")
                .font(.system(size: 44))
                .foregroundStyle(.tint)
            Text("SergeCode")
                .font(.largeTitle.bold())
            Text("Select a session, or start a new one.")
                .foregroundStyle(.secondary)
            Button("New Session", action: onNewSession)
                .buttonStyle(.glass)
                .controlSize(.large)
        }
        .padding(32)
        .glassEffect(.regular, in: .rect(cornerRadius: 24))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
