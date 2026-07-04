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
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

private enum InspectorTab: String, CaseIterable, Identifiable, Hashable {
    case diff
    case checkpoints

    var id: String { rawValue }

    var title: String {
        switch self {
        case .diff: "Diff"
        case .checkpoints: "Checkpoints"
        }
    }
}
