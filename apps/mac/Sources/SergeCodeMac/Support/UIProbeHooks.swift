import Foundation
import SwiftUI

/// Notification UIProbe (DEBUG-only) posts to drive collapsible sections
/// in-process — SwiftUI's AX tree doesn't resolve for same-process clients,
/// so probe runs toggle views through this instead. Compiled in all
/// configurations; nothing posts it outside probe runs. `object` is the
/// section key (for example "plan", "checkpoints", or "files"); the shell's
/// structural columns also accept "<key>.show" / "<key>.hide" so a probe can
/// drive them to a known state rather than toggling blind.
///
/// The sidebar's settled disclosure additionally accepts `"settled:<groupID>"`
/// to open one project's disclosure instead of every project's. A probe that
/// verifies one section has to drive that section and nothing else — a
/// broadcast lets any section supply the rows the check is looking for, so a
/// broken disclosure can pass on a neighbour's work.
extension Notification.Name {
    static let uiProbeToggleSection = Notification.Name("sergecode.uiprobe.toggleSection")

    /// Drives an open Alpine menu's rows in-process ("snooze-page",
    /// "snooze-first-preset"). The fallback path for probe runs where the
    /// accessibility tree gives up no frames to click; same compiled-in,
    /// posted-only-by-probes contract as `uiProbeToggleSection`.
    static let uiProbeMenuAction = Notification.Name("sergecode.uiprobe.menuAction")
}

/// Parsing for the sidebar's disclosure keys ("settled" and "snoozed"), kept
/// next to the notification that carries them so the wire format has one
/// definition.
///
/// Which sections a posted key asks to open is narrowed to those that exist.
/// The intersection is what makes the sidebar's report trustworthy: an
/// unrecognized group id would otherwise be unioned into the revealed set
/// and a probe checking `revealedSettledGroups.contains(id)` would see a
/// section open that never existed.
///
/// Group ids contain colons of their own ("name:sergecode",
/// "repository:github.com/…"), so the scoped form is read by dropping the
/// prefix rather than by splitting on the separator.
enum UIProbeDisclosureKey {
    static func targets(
        for key: String, broadcast: String, among known: Set<String>
    ) -> Set<String> {
        if key == broadcast { return known }
        let scopedPrefix = broadcast + ":"
        guard key.hasPrefix(scopedPrefix) else { return [] }
        return known.intersection([String(key.dropFirst(scopedPrefix.count))])
    }
}

enum UIProbeSettledKey {
    static let broadcast = "settled"

    static func targets(for key: String, among known: Set<String>) -> Set<String> {
        UIProbeDisclosureKey.targets(for: key, broadcast: broadcast, among: known)
    }

    static func scoped(to groupID: String) -> String {
        broadcast + ":" + groupID
    }
}

enum UIProbeSnoozedKey {
    static let broadcast = "snoozed"

    static func targets(for key: String, among known: Set<String>) -> Set<String> {
        UIProbeDisclosureKey.targets(for: key, broadcast: broadcast, among: known)
    }

    static func scoped(to groupID: String) -> String {
        broadcast + ":" + groupID
    }
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
    private(set) static var revealedSnoozedGroups: Set<String> = []

    static func recordRevealedSettled(_ groups: Set<String>) {
        revealedSettledGroups = groups
    }

    static func recordRevealedSnoozed(_ groups: Set<String>) {
        revealedSnoozedGroups = groups
    }

    static func reset() {
        revealedSettledGroups = []
        revealedSnoozedGroups = []
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

    /// Publishes which project sections have their snoozed disclosure open.
    func uiProbeRevealedSnoozed(_ groups: Set<String>) -> some View {
        onAppear { UIProbeSidebarState.recordRevealedSnoozed(groups) }
            .onChange(of: groups) { _, value in
                UIProbeSidebarState.recordRevealedSnoozed(value)
            }
    }
}
