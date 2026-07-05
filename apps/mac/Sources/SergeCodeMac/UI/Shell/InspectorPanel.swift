import SwiftUI

/// Tab picker hosting DiffPanelView / CheckpointListView for a thread,
/// presented inside the trailing inspector.
struct InspectorPanel: View {
    let model: AppModel
    let threadID: String

    @UIState private var tab: InspectorTab = .diff

    var body: some View {
        VStack(spacing: 0) {
            InspectorTabBar(selection: $tab)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)

            Divider()

            Group {
                switch tab {
                case .diff:
                    DiffPanelView(model: model, threadID: threadID)
                case .checkpoints:
                    CheckpointListView(model: model, threadID: threadID)
                case .plan:
                    PlanProgressView(model: model, threadID: threadID)
                case .files:
                    FileBrowserView(model: model, threadID: threadID)
                }
            }
            // Identity per tab so switching cross-fades panes instead of
            // hard-swapping the subtree in place.
            .id(tab)
            .transition(Motion.paneSwap)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .animation(Motion.settle, value: tab)
    }
}

private enum InspectorTab: String, CaseIterable, Identifiable, Hashable {
    case diff
    case checkpoints
    case plan
    case files

    var id: String { rawValue }

    var title: String {
        switch self {
        case .diff: "Diff"
        case .checkpoints: "History"
        case .plan: "Plan"
        case .files: "Files"
        }
    }

    var icon: String {
        switch self {
        case .diff: "plus.forwardslash.minus"
        case .checkpoints: "clock.arrow.circlepath"
        case .plan: "checklist"
        case .files: "folder"
        }
    }
}

/// Custom inspector tab switcher: equal-width segments over a glass capsule,
/// with an alpine-moss pill that slides under the selected tab. Replaces the
/// stock segmented picker so the inspector chrome carries the app's identity.
private struct InspectorTabBar: View {
    @Binding var selection: InspectorTab

    private let tabs = InspectorTab.allCases

    var body: some View {
        GeometryReader { proxy in
            let segmentWidth = proxy.size.width / CGFloat(tabs.count)
            let selectedIndex = tabs.firstIndex(of: selection) ?? 0

            ZStack(alignment: .leading) {
                Capsule()
                    .fill(AlpineTheme.accent.gradient)
                    .frame(width: segmentWidth, height: proxy.size.height)
                    .offset(x: segmentWidth * CGFloat(selectedIndex))
                    .animation(Motion.snap, value: selection)

                HStack(spacing: 0) {
                    ForEach(tabs) { tab in
                        segmentButton(tab, width: segmentWidth)
                    }
                }
            }
        }
        .frame(height: 46)
        .glassEffect(.regular, in: .capsule)
    }

    private func segmentButton(_ tab: InspectorTab, width: CGFloat) -> some View {
        Button {
            selection = tab
        } label: {
            VStack(spacing: 3) {
                Image(systemName: tab.icon)
                    .font(.system(size: 13, weight: .medium))
                Text(tab.title)
                    .font(.caption2.weight(.medium))
            }
            .foregroundStyle(selection == tab ? AnyShapeStyle(.white) : AnyShapeStyle(.secondary))
            .frame(width: width, height: 46)
            .contentShape(.capsule)
            .animation(Motion.ambient, value: selection)
        }
        .buttonStyle(.plain)
        .help(tab.title)
        .accessibilityAddTraits(selection == tab ? .isSelected : [])
    }
}

/// The agent's live in-turn todo list (`turn.plan.updated` activities).
struct PlanProgressView: View {
    let model: AppModel
    let threadID: String

    var body: some View {
        if let progress = model.planProgress[threadID], !progress.steps.isEmpty {
            List {
                if let explanation = progress.explanation, !explanation.isEmpty {
                    Text(explanation)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                ForEach(progress.steps) { step in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        statusIcon(step.status)
                        Text(step.title)
                            .font(.callout)
                            .strikethrough(step.status == .completed, color: .secondary)
                            .foregroundStyle(step.status == .completed ? .secondary : .primary)
                    }
                    .transition(Motion.rise)
                }
            }
            .listStyle(.inset)
            // Live todo updates stream in from the agent: new steps rise in,
            // status flips morph their icons.
            .animation(Motion.settle, value: progress.steps)
        } else {
            ContentUnavailableView(
                "No plan yet",
                systemImage: "list.bullet.clipboard",
                description: Text("The agent's todo list appears here while it works."))
        }
    }

    /// One `Image` so pending → in-progress → completed morphs via
    /// `.contentTransition` rather than swapping glyphs.
    private func statusIcon(_ status: PlanStepStatus) -> some View {
        Image(systemName: iconName(status))
            .symbolEffect(.pulse, isActive: status == .inProgress)
            .foregroundStyle(iconTint(status))
            .contentTransition(.symbolEffect(.replace))
    }

    private func iconName(_ status: PlanStepStatus) -> String {
        switch status {
        case .pending: "circle"
        case .inProgress: "circle.dotted"
        case .completed: "checkmark.circle.fill"
        }
    }

    private func iconTint(_ status: PlanStepStatus) -> Color {
        switch status {
        case .pending: .secondary
        case .inProgress: .accentColor
        case .completed: .green
        }
    }
}
