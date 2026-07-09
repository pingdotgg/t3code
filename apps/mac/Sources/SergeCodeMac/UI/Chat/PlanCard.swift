import SwiftUI

/// A proposed plan (plan mode output) rendered as a timeline item, with an
/// action to start the implementation turn. The plan body is long-form
/// reading content, so it stays opaque; only the card frame is glass.
public struct PlanCard: View {
    let plan: ProposedPlan
    let model: AppModel
    let onImplement: () -> Void

    @UIState private var isExpanded = true

    public init(plan: ProposedPlan, model: AppModel, onImplement: @escaping () -> Void) {
        self.plan = plan
        self.model = model
        self.onImplement = onImplement
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                withAnimation(Motion.snap) { isExpanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Label("Proposed plan", systemImage: "list.clipboard")
                        .font(.callout.weight(.semibold))
                    if plan.isImplemented {
                        Text("Implemented")
                            .font(.caption)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(.green.opacity(0.15), in: Capsule())
                            .foregroundStyle(.green)
                            .transition(Motion.materialize)
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }
            }
            .buttonStyle(.plain)

            if isExpanded {
                AssistantMarkdownView(
                    markdown: plan.markdown, isStreaming: false,
                    threadID: plan.threadID, model: model)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        Color(nsColor: .textBackgroundColor),
                        in: RoundedRectangle(cornerRadius: 8))
                    .transition(Motion.unfold)

                if !plan.isImplemented {
                    HStack {
                        Spacer()
                        Button("Implement plan") {
                            onImplement()
                        }
                        .buttonStyle(.glass)
                        .tint(.accentColor)
                    }
                    .transition(Motion.unfold)
                }
            }
        }
        .padding(14)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 16))
        // Implemented state arrives from the model, not a tap, so the badge
        // swap and button removal animate off this value change.
        .animation(Motion.settle, value: plan.isImplemented)
    }
}
