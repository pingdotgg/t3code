import SwiftUI

struct FeatureV2MessageAttribution: View {
    let source: OrchestrationV2TimelineMetadata
    let onOpenThread: ((String) -> Void)?

    static func hasContent(_ source: OrchestrationV2TimelineMetadata) -> Bool {
        source.scheduledTaskID != nil || source.createdBy == "agent"
            || ["queued_turn", "steer", "promoted_queued_to_steer"].contains(source.inputIntent ?? "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            if source.scheduledTaskID != nil {
                Text("Sent by automation")
            } else if source.createdBy == "agent" {
                if let threadID = source.senderThreadID, let onOpenThread {
                    Button("Sent by another agent") { onOpenThread(threadID) }
                        .buttonStyle(.plain)
                        .accessibilityHint("Open sending thread")
                } else { Text("Sent by another agent") }
            }
            if let intentLabel { Text(intentLabel) }
        }
        .font(T3Typography.supporting)
        .foregroundStyle(T3Colors.textSecondary)
    }

    private var intentLabel: String? {
        switch source.inputIntent {
        case "queued_turn": "Queued"
        case "steer": "Steer"
        case "promoted_queued_to_steer": "Queued → steer"
        default: nil
        }
    }
}
