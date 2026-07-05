import SwiftUI

/// Trailing inspector: the thread's diff, with the checkpoint list docked
/// underneath as a collapsible section. (Plan progress lives above the
/// composer in the chat; the file browser was dropped.)
struct InspectorPanel: View {
    let model: AppModel
    let threadID: String

    var body: some View {
        VStack(spacing: 0) {
            DiffPanelView(model: model, threadID: threadID)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider()
            CheckpointListView(model: model, threadID: threadID)
        }
    }
}
