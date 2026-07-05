import SwiftUI

/// Detail column for a selected thread: the chat timeline. The trailing
/// inspector is presented by RootView (a stable node), not here — this view
/// is recreated on every thread switch, and hosting the inspector on it made
/// the panel re-present, drop its width, and clip.
struct ThreadDetailView: View {
    let model: AppModel
    let scenery: SceneryStore
    let thread: ChatThread

    var body: some View {
        ChatScreen(model: model, scenery: scenery)
            .navigationTitle(thread.title)
    }
}
