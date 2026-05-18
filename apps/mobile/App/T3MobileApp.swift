import SwiftUI
import T3MobileProtocol

@main
struct T3MobileApp: App {
    private let timing = MobileProtocolTiming()

    init() {
        timing.mark(.appLaunchStart)
    }

    var body: some Scene {
        WindowGroup {
            AppRootView()
        }
    }
}
