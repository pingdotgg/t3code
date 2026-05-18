import SwiftUI

struct ConnectionStatusView: View {
    let state: MobileConnectionState

    var body: some View {
        Label(state.summary, systemImage: systemImage)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
            .background(.bar)
            .accessibilityLabel("Connection status")
            .accessibilityValue(state.summary)
    }

    private var systemImage: String {
        switch state {
        case .idle:
            "circle"
        case .notConfigured:
            "gearshape"
        case .connecting:
            "arrow.trianglehead.2.clockwise"
        case .connected:
            "checkmark.circle"
        case .failed:
            "exclamationmark.triangle"
        }
    }
}

#Preview {
    ConnectionStatusView(state: .notConfigured)
}
