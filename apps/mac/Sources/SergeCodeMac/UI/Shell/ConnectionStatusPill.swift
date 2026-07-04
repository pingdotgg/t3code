import SwiftUI

/// Dot + label summarizing the sidecar/websocket connection phase, shown in
/// the toolbar. No background of its own — the macOS 26 toolbar already
/// wraps items in glass, and stacking a second capsule read as a
/// double bubble.
struct ConnectionStatusPill: View {
    let phase: ConnectionPhase

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(tint)
                .frame(width: 6, height: 6)
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.horizontal, 4)
        .fixedSize()
    }

    private var label: String {
        switch phase {
        case .launchingServer: "Launching…"
        case .connecting: "Connecting…"
        case .ready: "Connected"
        case .reconnecting(let attempt): "Reconnecting (\(attempt))…"
        case .failed(let message): "Error: \(message)"
        }
    }

    private var tint: Color {
        switch phase {
        case .ready: .green
        case .launchingServer, .connecting, .reconnecting: .yellow
        case .failed: .red
        }
    }
}
