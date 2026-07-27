import SwiftUI

/// Pure turn-derivation for the chat turn rail, extracted so the rules are
/// unit-testable without a live `ScrollView`. A turn starts at each user
/// message; the rail renders one notch per turn and scrolls to the row whose
/// identity matches (`ChatTimelineScrollView` keys rows with `.id(item.id)`).
enum ChatTurnRailModel {
    struct Turn: Identifiable, Equatable, Sendable {
        /// The user message's row id — the same id the LazyVStack rows carry.
        let id: String
        /// One-line message excerpt for the notch tooltip.
        let preview: String
    }

    /// Cap for tooltip previews; long prompts collapse to a leading excerpt.
    static let previewLimit = 80

    static func turns(from displayItems: [TimelineDisplayItem]) -> [Turn] {
        displayItems.compactMap { item in
            // User messages are always `.single` (never tool-grouped), so
            // other display items — toolGroup, daySeparator — carry no turn.
            guard case .single(let timelineItem) = item,
                case .userMessage(let id, let text, _, _) = timelineItem
            else { return nil }
            return Turn(id: id, preview: preview(of: text))
        }
    }

    /// Collapses runs of whitespace/newlines into single spaces and caps the
    /// result at `previewLimit`, so a multi-paragraph prompt reads as one
    /// tooltip line.
    static func preview(of text: String) -> String {
        let collapsed = text
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        guard collapsed.count > previewLimit else { return collapsed }
        return String(collapsed.prefix(previewLimit - 1)) + "…"
    }
}

/// Codex-style turn navigation rail: a quiet column of notches pinned to the
/// leading edge of the chat timeline, one per conversation turn. Selecting a
/// notch scrolls the timeline to that turn's user message.
///
/// Each notch doubles as one cell of the thread's run tape: its tint carries
/// the turn's dominant `RunSignal` (failure, edit, tool work, talk), so a
/// long thread's shape — where it thrashed, where work landed — reads at a
/// glance without opening anything.
struct ChatTurnRail: View {
    let turns: [ChatTurnRailModel.Turn]
    /// Run-tape cell per turn, keyed by the opening user message's row id.
    /// Missing entries degrade to the neutral notch.
    let tape: [String: RunTapeCell]
    /// A dangling `.running` tool on a settled thread is not live work.
    let threadIsSettled: Bool
    let onSelect: (String) -> Void

    var body: some View {
        // One turn needs no navigation — the transcript is already one jump.
        if turns.count >= 2 {
            VStack(spacing: 9) {
                ForEach(Array(turns.enumerated()), id: \.element.id) { index, turn in
                    ChatTurnNotch(
                        number: index + 1,
                        preview: turn.preview,
                        cell: tape[turn.id],
                        threadIsSettled: threadIsSettled
                    ) {
                        onSelect(turn.id)
                    }
                }
            }
            .padding(.leading, 8)
            .frame(maxHeight: .infinity)
            // The rail floats over the scrolled content; only the notches
            // take pointer input so taps on the timeline pass through.
            // A plain VStack is not an accessibility element, so the group has
            // to be declared as a container or the label lands on nothing.
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Turn navigation")
        }
    }
}

/// A single rail notch: a slim capsule that widens and brightens on hover,
/// tinted by its turn's run-tape signal.
private struct ChatTurnNotch: View {
    /// 1-based position in the rail; the only thing distinguishing two notches
    /// for VoiceOver when the prompts read alike or the excerpt is empty.
    let number: Int
    let preview: String
    let cell: RunTapeCell?
    let threadIsSettled: Bool
    let action: () -> Void

    @UIState private var isHovering = false

    private var isLive: Bool {
        cell?.hasRunningTool == true && !threadIsSettled
    }

    /// Signal tints stay in the rail's quiet register: full strength only on
    /// hover, and the familiar neutral for talk/unknown turns so a
    /// conversation-only thread's rail looks exactly as it always has.
    private var tint: Color {
        if isLive { return AlpineTheme.accent }
        switch cell?.signal {
        case .fail: return AlpineTheme.destructive
        case .edit: return AlpineTheme.statusSuccess
        case .work: return AlpineTheme.sky
        case .talk, nil: return Color.secondary
        }
    }

    private var help: String {
        guard let cell, cell.toolCount > 0 else { return preview }
        return preview.isEmpty ? cell.summaryLine : "\(preview) — \(cell.summaryLine)"
    }

    var body: some View {
        Button(action: action) {
            Capsule()
                .fill(tint.opacity(isHovering ? 0.9 : 0.55))
                .frame(width: isHovering ? 14 : 10, height: 3)
                .pulseGlow(isActive: isLive)
                // Roomier invisible hit area; the visible pill stays subtle.
                .padding(.vertical, 3)
                .padding(.trailing, 4)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .animation(Motion.feedback, value: isHovering)
        .help(help)
        .accessibilityLabel(
            help.isEmpty ? "Jump to turn \(number)" : "Jump to turn \(number): \(help)")
    }
}
