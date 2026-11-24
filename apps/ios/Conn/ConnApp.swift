import DesignKit
import SwiftUI

@main
struct ConnApp: App {
    @UIApplicationDelegateAdaptor(ConnAppDelegate.self) private var appDelegate
    @State private var store: CoreStore
    @State private var push = PushRegistration.shared
    @Environment(\.scenePhase) private var scenePhase

    init() {
        ConnSymbols.install()
        // Mobile's `HEADER_TITLE_STYLE`: every native header title is 18pt, weight 500.
        UINavigationBar.appearance().titleTextAttributes = [
            .font: UIFont.systemFont(ofSize: 18, weight: .medium),
        ]
        let store = CoreStore()
        _store = State(initialValue: store)
        // Push taps can arrive at launch, before the first view appears.
        ConnAppDelegate.store = store
    }

    var body: some Scene {
        WindowGroup {
            ConnThemeProvider {
                Group {
                    // Rust's state decides: the full Orbit or pairing screen only until this
                    // scope has connected; after that a reconnect shows inline in the workspace.
                    if store.showsWorkspace {
                        WorkspaceRootView(store: store)
                    } else if let orbitConnect = store.orbitConnect {
                        OrbitConnectView(store: store, state: orbitConnect)
                    } else {
                        PairingView(store: store)
                    }
                }
            }
            .kitAppearance()
            .onChange(of: scenePhase) { _, newPhase in
                store.handleScenePhase(newPhase)
            }
            .onOpenURL { url in
                if let link = ThreadLink(url: url) {
                    store.open(link)
                }
            }
            .task {
                await push.start()
            }
            .sheet(isPresented: $push.showsExplainer) {
                PushExplainerSheet(
                    onTurnOn: { push.acceptExplainer() },
                    onNotNow: { push.declineExplainer() }
                )
            }
        }
    }
}
