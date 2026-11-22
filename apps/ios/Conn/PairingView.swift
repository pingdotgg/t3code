import DesignKit
import SwiftUI
import UIKit

struct PairingView: View {
    @Bindable var store: CoreStore
    @State private var pairingURL = ""
    @FocusState private var fieldFocused: Bool

    var body: some View {
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

                        Text("Connect to Conn")
                            .font(.kitHeading)

                        Text("Paste the pairing URL from your conn-server to open your threads.")
                            .font(.kitDetail)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, Kit.Space.xl)
                    }
                    .padding(.top, Kit.Space.xxxl)

                    KitGroup("Pairing URL", footer: "Example: http://127.0.0.1:3891/#token=...") {
                        HStack(spacing: Kit.Space.m) {
                            TextField("http://127.0.0.1:3891/#token=...", text: $pairingURL)
                                .font(.kitMono)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .keyboardType(.URL)
                                .submitLabel(.go)
                                .focused($fieldFocused)
                                .onSubmit(connect)
                                .accessibilityIdentifier("pairing.urlField")

                            if !pairingURL.isEmpty {
                                Button {
                                    pairingURL = ""
                                } label: {
                                    KitIconImage(.clear, size: 16)
                                        .foregroundStyle(.tertiary)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Clear URL")
                            }
                        }
                        .padding(.horizontal, Kit.rowInset)
                        .frame(minHeight: Kit.rowHeight)
                    }

                    if let error = store.lastError, !error.isEmpty {
                        Text(error)
                            .font(.kitDetail)
                            .foregroundStyle(Color.kitErrorText)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, Kit.Space.m)
                            .accessibilityIdentifier("pairing.errorText")
                    }

                    VStack(spacing: Kit.Space.m) {
                        Button(action: connect) {
                            Text("Connect")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.kitPrimary)
                        .disabled(pairingURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("pairing.connectButton")

                        Button {
                            if let pasted = UIPasteboard.general.string {
                                pairingURL = pasted.trimmingCharacters(in: .whitespacesAndNewlines)
                            }
                        } label: {
                            Label {
                                Text("Paste from Clipboard")
                            } icon: {
                                KitIconImage(.copy, size: 14)
                            }
                            .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.kit)
                        .accessibilityIdentifier("pairing.pasteButton")
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

    private func connect() {
        fieldFocused = false
        store.connectWithPairingURL(pairingURL)
    }
}
