import SwiftUI

struct FeatureUsageLimitRecoveryView: View {
    let recovery: FeatureUsageLimitRecovery
    let controlsAvailable: Bool
    let performAction: @MainActor (FeatureThreadRecoveryAction) async throws -> Void
    @State private var isUpdating = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let reset = recovery.resetDate {
                Text("Usage limit resets \(reset.formatted(date: .abbreviated, time: .shortened)).")
                if reset <= Date() {
                    Text("The reset time has passed. Retry the thread manually.")
                }
            } else {
                Text("The provider did not report a reset time. Retry when your limit is available.")
            }
            if recovery.canSchedule {
                checkbox("Resume at reset", choice: .autoResume, checked: recovery.autoResume)
                checkbox("Snooze until reset", choice: .snooze, checked: recovery.snooze)
            }
            if let error {
                Text(error).foregroundStyle(T3Colors.danger)
            }
        }
        .font(T3Typography.supporting)
        .foregroundStyle(.white)
        .buttonStyle(.plain)
        .padding(.vertical, 8)
        .accessibilityIdentifier("thread-usage-limit-recovery")
    }

    private func checkbox(_ title: String, choice: FeatureUsageLimitRecoveryChoice, checked: Bool) -> some View {
        Button {
            guard !isUpdating, let action = recovery.action(choice, enabled: !checked) else { return }
            isUpdating = true
            error = nil
            Task {
                defer { isUpdating = false }
                do { try await performAction(action) }
                catch { self.error = error.localizedDescription }
            }
        } label: {
            Label(title, systemImage: checked ? "checkmark.square.fill" : "square")
                .frame(minHeight: T3Metrics.minimumTapTarget, alignment: .leading)
        }
        .disabled(isUpdating || !controlsAvailable || !recovery.canChange(choice, enabled: !checked))
        .accessibilityValue(checked ? "On" : "Off")
        .accessibilityHint(checked ? (choice == .autoResume ? "Cancel auto-resume" : "Wake now") : title)
        .accessibilityIdentifier("thread-limit-\(choice.rawValue)")
    }
}

/// Existing files remain server-owned. New files use the composer's ordinary attachment controls.
struct FeatureQueuedRunEditBanner: View {
    @Binding var edit: FeatureQueuedRunEdit
    let isSaving: Bool
    let cancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(isSaving ? "Saving queued message…" : "Editing queued message")
                Spacer()
                Button("Cancel", action: cancel).disabled(isSaving)
                    .frame(minHeight: T3Metrics.minimumTapTarget)
            }
            ForEach(edit.existingAttachments) { attachment in
                HStack {
                    Label(attachment.name, systemImage: "paperclip").lineLimit(1)
                    Spacer()
                    Button {
                        edit.removeExistingAttachment(id: attachment.id)
                    } label: {
                        Image(systemName: "xmark").frame(width: T3Metrics.minimumTapTarget,
                                                        height: T3Metrics.minimumTapTarget)
                    }
                    .disabled(isSaving)
                    .accessibilityLabel("Remove \(attachment.name)")
                }
            }
        }
        .font(T3Typography.supporting)
        .foregroundStyle(.white)
        .buttonStyle(.plain)
    }
}
