import SwiftUI

/// A proposed plan rendered as a solid, predictable reading surface. A newer
/// decision card temporarily owns the next action, preventing competing calls
/// to action in the same transcript state.
public struct PlanCard: View {
    let plan: ProposedPlan
    let model: AppModel
    /// Whether this is the most-recent pending plan in the thread's
    /// timeline; gates `implementShortcut` (see ApprovalCard.swift for why
    /// Command-Shift-Return was chosen over the composer's own
    /// Command-Return send shortcut). An already-implemented plan never
    /// shows the button this attaches to, so this only matters when a
    /// newer, still-pending plan has superseded an older implemented one.
    let isActive: Bool
    let onImplement: () -> Void

    @UIState private var isExpanded = true

    private static let implementShortcut = KeyboardShortcut(.return, modifiers: [.command, .shift])

    public init(
        plan: ProposedPlan, model: AppModel, isActive: Bool, onImplement: @escaping () -> Void
    ) {
        self.plan = plan
        self.model = model
        self.isActive = isActive
        self.onImplement = onImplement
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                withAnimation(Motion.feedback) { isExpanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Label(plan.isImplemented ? "Plan" : "Plan ready", systemImage: "list.clipboard")
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
                    threadID: plan.threadID, messageID: plan.id, model: model,
                    showsRoleChrome: false)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .transition(Motion.unfold)

                if !plan.isImplemented {
                    HStack(spacing: 10) {
                        if !isActive {
                            Label(
                                "Resolve the newer decision before implementing.",
                                systemImage: "info.circle")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Implement plan") {
                            onImplement()
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(AlpineTheme.accent)
                        .disabled(!isActive)
                        .keyboardShortcut(isActive ? Self.implementShortcut : nil)
                        .help(isActive ? "Implement plan (⌘⇧⏎)" : "Implement plan")
                    }
                    .transition(Motion.unfold)
                }
            }
        }
        .padding(14)
        .background(
            Color(nsColor: .textBackgroundColor),
            in: RoundedRectangle(cornerRadius: AlpineTheme.Corners.card, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: AlpineTheme.Corners.card, style: .continuous)
                .stroke(.separator.opacity(0.65), lineWidth: 1)
        }
        // Implemented state arrives from the model, not a tap, so the badge
        // swap and button removal animate off this value change.
        .animation(Motion.structure, value: plan.isImplemented)
    }
}
