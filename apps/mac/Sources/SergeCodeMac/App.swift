import SwiftUI

@main
struct SergeCodeApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .defaultSize(width: 1100, height: 720)

        Settings {
            SettingsView()
        }
    }
}
