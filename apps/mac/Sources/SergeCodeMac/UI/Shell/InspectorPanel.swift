import SwiftUI

/// Tab picker hosting DiffPanelView / CheckpointListView for a thread,
/// presented inside the trailing inspector.
struct InspectorPanel: View {
    let model: AppModel
    let threadID: String

    @UIState private var tab: InspectorTab = .diff

    var body: some View {
        VStack(spacing: 0) {
            Picker("Inspector Tab", selection: $tab) {
                ForEach(InspectorTab.allCases) { tab in
                    Text(tab.title).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(12)

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
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
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
        case .checkpoints: "Checkpoints"
        case .plan: "Plan"
        case .files: "Files"
        }
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
                }
            }
            .listStyle(.inset)
        } else {
            ContentUnavailableView(
                "No plan yet",
                systemImage: "list.bullet.clipboard",
                description: Text("The agent's todo list appears here while it works."))
        }
    }

    @ViewBuilder
    private func statusIcon(_ status: PlanStepStatus) -> some View {
        switch status {
        case .pending:
            Image(systemName: "circle")
                .foregroundStyle(.secondary)
        case .inProgress:
            Image(systemName: "circle.dotted")
                .symbolEffect(.pulse)
                .foregroundStyle(Color.accentColor)
        case .completed:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
        }
    }
}
