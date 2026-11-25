import SwiftUI

struct OrbitConnectView: View {
    let store: CoreStore
    let state: OrbitConnectState
    @Environment(\.connTheme) private var theme

    var body: some View {
        ZStack {
            theme.background.ignoresSafeArea()
            Image("LaunchMark")
                .resizable()
                .scaledToFit()
                .frame(width: 96, height: 64)
                .accessibilityHidden(true)
            switch state {
            case let .connecting(message):
                VStack {
                    Spacer()
                    Text(message)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(theme.mutedForeground)
                        .accessibilityIdentifier("orbit.connecting")
                }.padding(.bottom, 12)
            case let .failed(message, detail):
                Color.black.opacity(0.36).ignoresSafeArea()
                VStack(spacing: 0) {
                    Text(message)
                        .font(.headline)
                        .accessibilityIdentifier("orbit.errorText")
                    if let detail, !detail.isEmpty {
                        Text(detail).font(.subheadline).foregroundStyle(.secondary).padding(.top, 6)
                    }
                    Divider().padding(.top, 16)
                    HStack(spacing: 0) {
                        Button("Connect manually") { store.showManualPairing() }
                            .frame(maxWidth: .infinity)
                            .accessibilityIdentifier("orbit.manualButton")
                        Divider()
                        Button("Try again") { store.retry() }
                            .fontWeight(.semibold)
                            .frame(maxWidth: .infinity)
                            .accessibilityIdentifier("orbit.retryButton")
                    }.frame(height: 46)
                }
                .multilineTextAlignment(.center)
                .padding(.horizontal, 12)
                .padding(.top, 20)
                .frame(maxWidth: 300)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20))
            }
        }
    }
}
