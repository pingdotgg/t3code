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
        .onAppear { isPulsing = isSettling && !Motion.reduceMotion }
        .onChange(of: isSettling) { _, settling in
            isPulsing = settling && !Motion.reduceMotion
        }
    }

    private var isSettling: Bool {
        switch phase {
        case .launchingServer, .connecting, .reconnecting: true
        case .ready, .unauthorized, .failed: false
        }
    }

    private var label: String {
        switch phase {
        case .launchingServer: "Launching…"
        case .connecting: "Connecting…"
        case .ready: "Connected"
        case .reconnecting(let attempt): "Reconnecting (\(attempt))…"
        case .unauthorized: "Re-pairing required"
        case .failed(let message): "Error: \(message)"
        }
    }

    private var tint: Color {
        switch phase {
        case .ready: .green
        case .launchingServer, .connecting, .reconnecting: .yellow
        case .unauthorized: .orange
        case .failed: .red
        }
    }
}
