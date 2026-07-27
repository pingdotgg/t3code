import SwiftUI

/// When the trailing inspector may be on screen.
///
/// The panel is per-thread (a changes timeline), and RootView disables its
/// toolbar toggle while no thread is selected — so presenting it on the
/// welcome hero produces a panel with nothing in it and no way to close it.
/// Selection is therefore a precondition for presentation, not just for the
/// panel's content.
enum InspectorPresentation {
    static func isPresented(requested: Bool, hasSelection: Bool) -> Bool {
        requested && hasSelection
    }
}

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
