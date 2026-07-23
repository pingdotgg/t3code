import SwiftUI

/// Trailing inspector: slim changes timeline (All Changes + checkpoints).
/// Code review opens in the main content area, not here.
struct InspectorPanel: View {
    let model: AppModel
    let threadID: String

    var body: some View {
        ChangesTimelineView(model: model, threadID: threadID)
            // RootView keeps this panel alive across thread switches (see
            // ThreadDetailView), so key the arrival on the thread it is showing.
            .entrance(.pane)
            .id(threadID)
    }
}
