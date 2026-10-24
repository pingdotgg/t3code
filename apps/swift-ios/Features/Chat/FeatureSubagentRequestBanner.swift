import SwiftUI

struct FeatureSubagentRequestBanner: View {
    let children: [OrchestrationV2SubagentRequestTarget]
    let onOpenThread: @MainActor (String) -> Void

    var body: some View {
        if let child = children.first {
            Button {
                onOpenThread(FeatureScopedID.thread(environmentID: child.environmentID, wireID: child.threadID))
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "hand.raised")
                    Text(OrchestrationV2SubagentRequests.childInputsTitle(children))
                        .font(T3Typography.control)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(T3Typography.supporting)
                }
                .foregroundStyle(Color.white)
                .frame(minHeight: T3Metrics.minimumTapTarget)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open \(child.request == .approval ? "approval" : "question") from \(child.title)")
            .accessibilityIdentifier("thread-subagent-request")
        }
    }
}
