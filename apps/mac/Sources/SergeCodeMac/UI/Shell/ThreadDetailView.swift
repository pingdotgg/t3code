import SwiftUI

/// Detail column for a selected thread: chat timeline with a toggleable
/// trailing inspector hosting the diff/checkpoint tab picker.
struct ThreadDetailView: View {
    let model: AppModel
    let scenery: SceneryStore
    let thread: ChatThread
    @Binding var showInspector: Bool

    var body: some View {
        ChatScreen(model: model, scenery: scenery)
            .navigationTitle(thread.title)
            .inspector(isPresented: $showInspector) {
                InspectorPanel(model: model, threadID: thread.id)
                    .inspectorColumnWidth(min: 280, ideal: 340, max: 420)
            }
    }
}
