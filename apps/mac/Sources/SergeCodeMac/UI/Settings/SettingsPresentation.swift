import SwiftUI

/// In-window settings presentation: whether the takeover is up and which tab
/// it shows. Owned by the App struct so menu commands can drive it, and
/// injected into the environment so deep views (the composer's model picker)
/// can deep-link to a specific tab.
///
/// Every mutation is deferred one runloop turn: presenting and dismissing
/// flip the window toolbar's visibility, and the triggers live in toolbar
/// buttons and menu items that can fire mid-layout — the same AppKit
/// layout-feedback-loop guard RootView's structural toggles defer around.
@MainActor
@Observable
public final class SettingsPresentation {
    public private(set) var isPresented = false
    public var tab: SettingsTab = .general

    public init() {}

    /// Presents the settings surface, optionally jumping to a specific tab.
    /// Reuses the last-viewed tab when none is given, matching how a
    /// re-opened Settings window would behave.
    public func open(_ tab: SettingsTab? = nil) {
        DispatchQueue.main.async {
            if let tab { self.tab = tab }
            self.isPresented = true
        }
    }

    public func close() {
        DispatchQueue.main.async {
            self.isPresented = false
        }
    }

    /// ⌘, behavior: opens when closed, closes when already up — the takeover
    /// replaces the main content, so the shortcut doubles as the way back.
    public func toggle() {
        DispatchQueue.main.async {
            self.isPresented.toggle()
        }
    }
}
