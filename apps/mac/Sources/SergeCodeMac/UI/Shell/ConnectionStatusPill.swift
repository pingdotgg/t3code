import SwiftUI

/// Dot + label summarizing the sidecar/websocket connection phase, shown in
/// the toolbar. No background of its own — the macOS 26 toolbar already
/// wraps items in glass, and stacking a second capsule read as a
/// double bubble.
struct ConnectionStatusPill: View {
    let phase: ConnectionPhase

    // Mirrors `isSettling`, but set after the first frame (onAppear) so the
    // heartbeat animates even when the app launches already mid-connect —
    // `.animation(_, value:)` only fires on a *change*.
    @UIState private var isPulsing = false

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(tint)
                .frame(width: 6, height: 6)
                // Gentle heartbeat while the connection is in flight; steady
                // once ready (or failed).
                .scaleEffect(isPulsing ? 1.25 : 1.0)
                .animation(
                    isPulsing
                        ? Motion.ambient.repeatForever(autoreverses: true)
                        : Motion.ambient,
                    value: isPulsing)
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .contentTransition(.numericText())
        }
        .padding(.horizontal, 4)
        .fixedSize()
        .animation(Motion.ambient, value: phase)
        .onAppear { isPulsing = phase.isSettling && !Motion.reduceMotion }
        .onChange(of: phase.isSettling) { _, settling in
            isPulsing = settling && !Motion.reduceMotion
        }
    }

    private var label: String {
        phase.statusText
    }

    private var tint: Color {
        // The toolbar intentionally uses a yellow heartbeat for in-flight
        // work; the canonical settling color remains `.secondary` elsewhere.
        phase.isSettling ? .yellow : phase.statusColor
    }
}
