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
struct ChatTurnRail: View {
    let turns: [ChatTurnRailModel.Turn]
    let onSelect: (String) -> Void

    var body: some View {
        // One turn needs no navigation — the transcript is already one jump.
        if turns.count >= 2 {
            VStack(spacing: 9) {
                ForEach(turns) { turn in
                    ChatTurnNotch(preview: turn.preview) {
                        onSelect(turn.id)
                    }
                }
            }
            .padding(.leading, 8)
            .frame(maxHeight: .infinity)
            // The rail floats over the scrolled content; only the notches
            // take pointer input so taps on the timeline pass through.
            .accessibilityLabel("Turn navigation")
        }
    }
}

/// A single rail notch: a slim capsule that widens and brightens on hover.
private struct ChatTurnNotch: View {
    let preview: String
    let action: () -> Void

    @UIState private var isHovering = false

    var body: some View {
        Button(action: action) {
            Capsule()
                .fill(Color.secondary.opacity(isHovering ? 0.9 : 0.45))
                .frame(width: isHovering ? 14 : 10, height: 3)
                // Roomier invisible hit area; the visible pill stays subtle.
                .padding(.vertical, 3)
                .padding(.trailing, 4)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovering = $0 }
        .animation(Motion.feedback, value: isHovering)
        .help(preview)
    }
}
