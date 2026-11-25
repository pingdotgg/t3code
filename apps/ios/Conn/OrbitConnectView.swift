import DesignKit
import SwiftUI

/// Shown while the app finds its Conn server through Orbit, or after that failed. Rust picks the
/// target and says why it failed; Try again repeats the same target.
struct OrbitConnectView: View {
    let store: CoreStore
    let state: OrbitConnectState

    var body: some View {
        if case .connecting = state {
            VStack {
                Spacer()
                Image("LaunchMark")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 96, height: 64)
                    .accessibilityHidden(true)
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay(alignment: .bottom) {
                Text("Checking connection")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(.secondary)
                    .padding(.bottom, 12)
                    .accessibilityIdentifier("orbit.connecting")
            }
            .background(Color.kitContent.ignoresSafeArea())
        } else {
            failure
        }
    }

    private var failure: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: Kit.Space.xxl) {
                    VStack(spacing: Kit.Space.m) {
                        ZStack {
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .fill(Color.kitTile)
                                .frame(width: 56, height: 56)
                            KitIconImage(.server, size: 24)
                                .foregroundStyle(.primary)
                        }

                        if case let .failed(message, detail) = state {
                            Text("Couldn't connect")
                                .font(.kitHeading)
                            Text(message)
                                .font(.kitDetail)
                                .foregroundStyle(Color.kitErrorText)
                                .multilineTextAlignment(.center)
                                .padding(.horizontal, Kit.Space.xl)
                                .accessibilityIdentifier("orbit.errorText")
                            if let detail, !detail.isEmpty {
                                Text(detail)
                                    .font(.kitDetail)
                                    .foregroundStyle(.secondary)
                                    .multilineTextAlignment(.center)
                                    .padding(.horizontal, Kit.Space.xl)
                            }
                        }
                    }
                    .padding(.top, Kit.Space.xxxl)

                    VStack(spacing: Kit.Space.m) {
                        if case .failed = state {
                            Button {
                                store.retry()
                            } label: {
                                Text("Try again")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.kitPrimary)
                            .accessibilityIdentifier("orbit.retryButton")
                        }

                        Button("Connect manually") {
                            store.showManualPairing()
                        }
                        .buttonStyle(.plain)
                        .font(.kitDetail)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("orbit.manualButton")
                    }
                }
                .padding(.horizontal, Kit.contentInset)
                .padding(.bottom, Kit.Space.xxxl)
            }
            .background(Color.kitContent.ignoresSafeArea())
            .navigationTitle("Conn")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
