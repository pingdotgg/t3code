import Foundation

/// Notification UIProbe (DEBUG-only) posts to drive collapsible sections
/// in-process — SwiftUI's AX tree doesn't resolve for same-process clients,
/// so probe runs toggle views through this instead. Compiled in all
/// configurations; nothing posts it outside probe runs. `object` is the
/// section key (for example "plan", "checkpoints", or "agents").
extension Notification.Name {
    static let uiProbeToggleSection = Notification.Name("sergecode.uiprobe.toggleSection")
}
