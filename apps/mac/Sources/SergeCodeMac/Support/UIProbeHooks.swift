import Foundation
import SwiftUI

/// Notification UIProbe (DEBUG-only) posts to drive collapsible sections
/// in-process — SwiftUI's AX tree doesn't resolve for same-process clients,
/// so probe runs toggle views through this instead. Compiled in all
/// configurations; nothing posts it outside probe runs. `object` is the
/// section key (for example "plan", "checkpoints", or "files"); the shell's
/// structural columns also accept "<key>.show" / "<key>.hide" so a probe can
/// drive them to a known state rather than toggling blind.
extension Notification.Name {
    static let uiProbeToggleSection = Notification.Name("sergecode.uiprobe.toggleSection")
}

/// What the sidebar's disclosures are currently showing.
///
/// Driving a section is only half of what a probe needs; the other half is
/// knowing what the section was doing beforehand. `revealedSettled` is SwiftUI
/// `@UIState` with no in-process accessor, and the accessibility tree does not
/// resolve for same-process clients, so the view reports it — the same
/// self-reporting pattern `UIProbeMenus` and `UIProbeGitStrip` use.
///
/// Without this a probe can only infer the disclosure from a global row-count
/// delta, which is wrong in both directions: the reveal notification *unions*
/// rather than toggles, so a section that was already open contributes no new
/// rows and the expected delta is never reached, while an unrelated section
/// opening in the same pass contributes rows that were never asked for.
@MainActor
enum UIProbeSidebarState {
    private(set) static var revealedSettledGroups: Set<String> = []

    static func recordRevealedSettled(_ groups: Set<String>) {
        revealedSettledGroups = groups
    }

    static func reset() {
        revealedSettledGroups = []
    }
}

extension View {
    /// Publishes which project sections have their settled disclosure open, so
    /// a probe can tell "already open" from "just opened". Reports on appear as
    /// well as on change: a section restored open from persisted state never
    /// fires a change.
    func uiProbeRevealedSettled(_ groups: Set<String>) -> some View {
        onAppear { UIProbeSidebarState.recordRevealedSettled(groups) }
            .onChange(of: groups) { _, value in
                UIProbeSidebarState.recordRevealedSettled(value)
            }
    }
}
