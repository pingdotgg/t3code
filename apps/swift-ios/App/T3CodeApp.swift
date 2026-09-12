import SwiftUI

@main
@MainActor
struct T3CodeApp: App {
    @UIApplicationDelegateAdaptor(T3PlatformAppDelegate.self) private var appDelegate
    @State private var model: FeatureRootModel

    init() {
        let client = NativeFeatureClient()
        let model = FeatureRootModel(client: client)
        _model = State(initialValue: model)
        PlatformCloudDeliveryCoordinator.shared.install(
            controller: client.t3ConnectController
        )
        PlatformBackgroundRefreshCoordinator.shared.install { [weak model] in
            guard let model else { return false }
            return await model.refreshInBackground()
        }
    }

    var body: some Scene {
        WindowGroup {
            RootView {
                PlatformRootView(model: model)
            }
        }
    }
}
