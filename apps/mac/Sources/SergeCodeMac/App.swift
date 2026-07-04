import SwiftUI

// App entry point. AppModel is a reference type (@Observable class), so a
// plain `let` on the App struct is sufficient — no @State needed (and @State
// is unusable here anyway, see Support/StateShim.swift). The model is passed
// explicitly down the view tree rather than injected via .environment, to
// match the explicit `model:` init parameter used by every screen-level view.
@main
struct SergeCodeApp: App {
    private let model = AppModel(backend: MockBackend())

    var body: some Scene {
        WindowGroup {
            RootView(model: model)
                .containerBackground(.thinMaterial, for: .window)
                .onAppear { model.start() }
        }
        .defaultSize(width: 1100, height: 720)

        Settings {
            SettingsScene(model: model)
        }
    }
}
