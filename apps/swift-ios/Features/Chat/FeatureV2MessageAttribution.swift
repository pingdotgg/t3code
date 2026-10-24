import SwiftUI

struct FeatureV2MessageAttribution: View {
    let source: OrchestrationV2TimelineMetadata
    let onOpenThread: ((String) -> Void)?

    enum Attribution: String {
        case automation = "Sent by automation"
        case agent = "Sent by another agent"
        case t3code = "Sent by T3 Code"
    }

    static func attribution(_ source: OrchestrationV2TimelineMetadata) -> Attribution? {
        if source.scheduledTaskID != nil { return .automation }
        guard source.createdBy == "agent" else { return nil }
        return source.creationSource == "server" ? .t3code : .agent
    }

    static func hasContent(_ source: OrchestrationV2TimelineMetadata) -> Bool {
        attribution(source) != nil
            || ["queued_turn", "steer", "promoted_queued_to_steer"].contains(source.inputIntent ?? "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            if let attribution = Self.attribution(source) {
                if attribution == .agent, let threadID = source.senderThreadID, let onOpenThread {
                    Button(attribution.rawValue) { onOpenThread(threadID) }
                        .buttonStyle(.plain)
                        .accessibilityHint("Open sending thread")
                } else { Text(attribution.rawValue) }
            }
            if let intentLabel {
                Text(intentLabel)
                    .accessibilityLabel(intentAccessibilityLabel ?? intentLabel)
            }
        }
        .font(T3Typography.supporting)
        .foregroundStyle(T3Colors.textSecondary)
    }

    private var intentAccessibilityLabel: String? {
        switch source.inputIntent {
        case "queued_turn": "Queued while the agent was busy"
        case "steer": "Steered the active turn"
        case "promoted_queued_to_steer": "Originally queued, then promoted to steer the active turn"
        default: nil
        }
    }

    private var intentLabel: String? {
        switch source.inputIntent {
        case "queued_turn": "From queue"
        case "steer": "Steer"
        case "promoted_queued_to_steer": "Queued → steer"
        default: nil
        }
    }
}
