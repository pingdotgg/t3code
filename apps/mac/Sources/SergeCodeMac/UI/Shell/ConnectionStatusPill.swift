import SwiftUI

/// Dot + label summarizing the sidecar/websocket connection phase, shown in
/// the toolbar. Uses a non-interactive Alpine glass chip after the system
/// per-item capsule is suppressed with `.sharedBackgroundVisibility(.hidden)`.
struct ConnectionStatusPill: View {
    let phase: ConnectionPhase

    /// Changes only for a live non-ready → ready transition. An already-ready
    /// toolbar render does not replay the success accent.
    @UIState private var connectionSuccessBeat = 0

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "circle.fill")
                .font(.system(size: 6, weight: .semibold))
                .foregroundStyle(tint)
                .symbolEffect(.bounce, value: connectionSuccessBeat)
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .contentTransition(.numericText())
        }
        .fixedSize()
        .alpineToolbarChip(interactive: false)
        .animation(Motion.ambient, value: phase)
        .onChange(of: phase) { oldPhase, newPhase in
            guard oldPhase != .ready, newPhase == .ready,
                Motion.profile.allowsDecorativeEffects
            else { return }
            connectionSuccessBeat += 1
        }
    }

    private var label: String {
        phase.statusText
    }

    private var tint: Color {
        // Lichen communicates in-flight work without perpetual movement.
        phase.isSettling ? AlpineTheme.lichen : phase.statusColor
    }
}
