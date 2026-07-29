import SwiftUI

/// A proposed plan rendered as a calm reading surface with one clear next
/// action. The header carries the plan-mode lavender identity (see
/// `ThreadInteractionMode.tint`) so the card reads as part of plan mode
/// rather than a generic gray box; the hairline re-tints to success green
/// once the plan lands. A newer decision card temporarily owns the next
/// action, preventing competing calls to action in the same transcript
/// state.
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
        VStack(alignment: .leading, spacing: 0) {
            header
            if isExpanded {
                expandedBody
                    .padding(.top, 12)
                    .transition(Motion.unfold)
            }
        }
        .padding(14)
        // The scenery layer already carries the transcript legibility wash;
        // keep Plan on the same lightweight glass requested for chat chrome.
        .alpineGlassSurface(
            in: RoundedRectangle(
                cornerRadius: AlpineTheme.Corners.card, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: AlpineTheme.Corners.card, style: .continuous)
                .stroke(borderTint, lineWidth: 1)
        }
        // Implemented state arrives from the model, not a tap, so the badge
        // swap, border re-tint, and button removal animate off this value
        // change. The rare success beat gets the delight budget; the ripple
        // fires only on the false→true edge, so a restored transcript never
        // replays it.
        .animation(Motion.delight, value: plan.isImplemented)
        .successRipple(fire: plan.isImplemented, cornerRadius: AlpineTheme.Corners.card)
        // Arrival is owned by the timeline ForEach's `.entrance(.row)` — a
        // second `.entrance(.card)` here doubled the entrance travel.
    }

    // MARK: - Header

    private var header: some View {
        Button {
            withDeferredDisclosureAnimation { isExpanded.toggle() }
        } label: {
            HStack(spacing: 10) {
                iconTile
                VStack(alignment: .leading, spacing: 1) {
                    Text(plan.isImplemented ? "Plan" : "Plan ready for review")
                        .font(.callout.weight(.semibold))
                    if !plan.isImplemented {
                        Text("Review the proposal, then implement when ready.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                if plan.isImplemented {
                    implementedBadge
                        .transition(Motion.materialize)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .rotationEffect(.degrees(isExpanded ? 0 : -90))
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(isExpanded ? "Collapse plan" : "Expand plan")
    }

    /// The plan glyph on a soft lavender tile — the same pastel identity
    /// plan mode wears in the composer, so the card is recognizable before
    /// a word is read.
    private var iconTile: some View {
        Image(systemName: "list.clipboard")
            .font(.callout.weight(.semibold))
            .foregroundStyle(AlpineTheme.lavender)
            .frame(width: 30, height: 30)
            .background(
                AlpineTheme.lavender.opacity(0.16),
                in: RoundedRectangle(cornerRadius: AlpineTheme.Corners.control, style: .continuous))
    }

    private var implementedBadge: some View {
        Label("Implemented", systemImage: "checkmark")
            .font(.caption.weight(.medium))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(AlpineTheme.statusSuccess.opacity(0.15), in: Capsule())
            .foregroundStyle(AlpineTheme.statusSuccess)
    }

    // MARK: - Body

    private var expandedBody: some View {
        VStack(alignment: .leading, spacing: 12) {
            Rectangle()
                .fill(.separator.opacity(0.5))
                .frame(height: 1)

            AssistantMarkdownView(
                markdown: plan.markdown, isStreaming: false,
                threadID: plan.threadID, messageID: plan.id, model: model,
                showsRoleChrome: false)
                .frame(maxWidth: .infinity, alignment: .leading)

            if !plan.isImplemented {
                footer
                    .transition(Motion.unfold)
            }
        }
    }

    private var footer: some View {
        HStack(spacing: 10) {
            if !isActive {
                Label(
                    "Resolve the newer decision before implementing.",
                    systemImage: "info.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                // Same weight as approving a request: this hands the plan to
                // the agent to execute.
                Haptics.play(.decision)
                onImplement()
            } label: {
                Label("Implement plan", systemImage: "play.fill")
            }
            // Glass for the action, tinted meadow like ApprovalCard's
            // Approve — decision buttons across the timeline share one look.
            .buttonStyle(.glass)
            .tint(AlpineTheme.meadow)
            .disabled(!isActive)
            .keyboardShortcut(isActive ? Self.implementShortcut : nil)
            .help(isActive ? "Implement plan (⌘⇧⏎)" : "Implement plan")
        }
    }

    private var borderTint: Color {
        plan.isImplemented
            ? AlpineTheme.statusSuccess.opacity(0.4)
            : AlpineTheme.lavender.opacity(0.4)
    }
}
