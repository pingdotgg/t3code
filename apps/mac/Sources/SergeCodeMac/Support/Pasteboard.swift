import AppKit

/// Thin wrapper over the general pasteboard so message/code copy actions
/// share one implementation.
@MainActor
enum Pasteboard {
    static func copy(_ string: String) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(string, forType: .string)
    }
}
