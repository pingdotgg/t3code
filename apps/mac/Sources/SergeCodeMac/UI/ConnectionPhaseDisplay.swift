import SwiftUI

/// Shared presentation mapping for connection state. Views may make a small,
/// explicit visual override (for example, the toolbar pill's yellow settling
/// dot), but the phase-to-meaning mapping lives here.
extension ConnectionPhase {
    var statusText: String {
        switch self {
        case .launchingServer: "Launching Server…"
        case .connecting: "Connecting…"
        case .ready: "Connected"
        case .reconnecting(let attempt): "Reconnecting (attempt \(attempt))…"
        case .unauthorized: "Re-pairing required"
        case .failed(let message): "Failed: \(message)"
        }
    }

    var symbolName: String {
        switch self {
        case .launchingServer, .connecting, .reconnecting: "arrow.triangle.2.circlepath"
        case .ready: "checkmark.circle.fill"
        case .unauthorized: "key.slash"
        case .failed: "exclamationmark.triangle.fill"
        }
    }

    var statusColor: Color {
        switch self {
        case .launchingServer, .connecting, .reconnecting: .secondary
        case .ready: .green
        case .unauthorized: .orange
        case .failed: .red
        }
    }

    var isSettling: Bool {
        switch self {
        case .launchingServer, .connecting, .reconnecting: true
        case .ready, .unauthorized, .failed: false
        }
    }

    var accessibilityLabel: String {
        switch self {
        case .ready: "Ready"
        case .failed: "Connection failed"
        case .unauthorized: "Re-pairing required"
        case .launchingServer, .connecting, .reconnecting: "Connecting"
        }
    }
}
