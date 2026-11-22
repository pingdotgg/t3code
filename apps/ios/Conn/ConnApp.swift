import DesignKit
import SwiftUI

@main
struct ConnApp: App {
    @State private var store = CoreStore()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        ConnSymbols.install()
    }

    var body: some Scene {
        WindowGroup {
            ConnThemeProvider {
                Group {
                    if store.isPaired {
                        WorkspaceRootView(store: store)
                    } else {
                        PairingView(store: store)
                    }
                }
            }
            .kitAppearance()
            .onChange(of: scenePhase) { _, newPhase in
                store.handleScenePhase(newPhase)
            }
        }
    }
}
