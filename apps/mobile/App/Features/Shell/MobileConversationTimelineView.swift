import SwiftUI

struct MobileConversationTimelineView: View {
    let detail: MobileThreadDetail
    let respondedRequestIDs: Set<String>
    let respondingRequestIDs: Set<String>
    var onApprove: (String, String) -> Void = { _, _ in }
    var onUserInput: (String, String) -> Void = { _, _ in }
    var onShowDiff: (MobileCheckpointSummary) -> Void = { _ in }
    var onRevertCheckpoint: (MobileCheckpointSummary) -> Void = { _ in }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: MobileDesign.spacing) {
                    ForEach(detail.timelineItems) { item in
                        switch item {
                        case let .message(message):
                            MobileMessageBubbleView(message: message)
                                .id(item.id)
                        case let .activity(activity):
                            MobileActivityRowView(
                                activity: activity,
                                isResponded: activity.requestID.map { respondedRequestIDs.contains($0) } ?? false,
                                isResponding: activity.requestID.map { respondingRequestIDs.contains($0) } ?? false,
                                onApprove: onApprove,
                                onUserInput: onUserInput
                            )
                                .id(item.id)
                        case let .plan(plan):
                            MobileProposedPlanCardView(plan: plan)
                                .id(item.id)
                        case let .checkpoint(checkpoint):
                            MobileCheckpointCardView(
                                checkpoint: checkpoint,
                                onShowDiff: onShowDiff,
                                onRevert: onRevertCheckpoint
                            )
                            .id(item.id)
                        }
                    }
                }
                .padding(.vertical, MobileDesign.spacing)
            }
            .onChange(of: detail.timelineItems.last?.id) {
                guard let lastID = detail.timelineItems.last?.id else {
                    return
                }
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo(lastID, anchor: .bottom)
                }
            }
        }
    }

}

#Preview {
    MobileConversationTimelineView(
        detail: MobilePreviewData.threadDetail,
        respondedRequestIDs: [],
        respondingRequestIDs: []
    )
        .padding()
}
