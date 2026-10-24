import SwiftUI

/// Also used outside Add Project so a reopened draft retains clone controls.
struct FeatureProjectCloneStatusView: View {
    let clone: FeatureManagedProjectClone
    @Bindable var controller: FeatureProjectCloneController
    let client: any FeatureManagedProjectCloning
    var onRemoved: @MainActor () -> Void = {}
    @State private var confirmsRemoval = false

    var body: some View {
        if clone.snapshot.phase != .done {
            VStack(alignment: .leading, spacing: 8) {
                Text(title).font(.headline)
                if clone.snapshot.phase == .running {
                    Text(clone.snapshot.progressSummary).font(.caption)
                    if let percent = clone.snapshot.percent {
                        ProgressView(value: Double(percent), total: 100)
                    }
                }
                if let error = clone.snapshot.error { Text(error).font(.caption).textSelection(.enabled) }
                HStack {
                    if clone.snapshot.phase == .running {
                        Button("Cancel clone") { perform(.cancel) }
                    } else {
                        Button("Retry clone") { perform(.retry) }
                        Button("Remove project", role: .destructive) { confirmsRemoval = true }
                    }
                }
                .disabled(controller.pendingActionID != nil)
                if let errorMessage = controller.errorMessage {
                    Text(errorMessage).font(.caption).foregroundStyle(T3Colors.textSecondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .foregroundStyle(T3Colors.textPrimary)
            .confirmationDialog("Remove this project and its incomplete clone?", isPresented: $confirmsRemoval) {
                Button("Remove project", role: .destructive) {
                    Task { if await controller.remove(clone, client: client) { onRemoved() } }
                }
            }
        }
    }

    private var title: String {
        switch clone.snapshot.phase {
        case .running: "Cloning \(clone.snapshot.displayName)"
        case .failed: "Failed to clone \(clone.snapshot.displayName)"
        case .cancelled: "Cancelled cloning \(clone.snapshot.displayName)"
        case .done: "Cloned \(clone.snapshot.displayName)"
        }
    }

    private func perform(_ action: ProjectCloneAction) {
        Task { await controller.perform(action, clone: clone, client: client) }
    }
}
