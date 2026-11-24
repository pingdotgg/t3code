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

                        Button(action: pasteFromClipboard) {
                            Label {
                                Text("Paste from Clipboard")
                            } icon: {
                                KitIconImage(.copy, size: 14)
                            }
                            .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.kit)
                        .accessibilityIdentifier("pairing.pasteButton")

                        Button("Connect through Orbit") {
                            fieldFocused = false
                            store.connectThroughOrbit()
                        }
                        .buttonStyle(.plain)
                        .font(.kitDetail)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("pairing.orbitButton")
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

    private func pasteFromClipboard() {
        let board = UIPasteboard.general
        if let text = PairingPaste.text(url: board.url, string: board.string) {
            pairingURL = text
            store.lastError = nil
        } else {
            store.lastError = PairingPaste.emptyMessage
        }
    }

    private func connect() {
        fieldFocused = false
        store.connectWithPairingURL(pairingURL)
    }
}

/// The clipboard as a pairing URL. "Copy Link" in Safari, Messages or Conn stores a URL item with
/// no string, so the URL comes first; a denied paste leaves both empty.
enum PairingPaste {
    static let emptyMessage =
        "The clipboard has no pairing URL. Copy the link again, or paste it into the field."

    static func text(url: URL?, string: String?) -> String? {
        for candidate in [url?.absoluteString, string] {
            if let text = candidate?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
                return text
            }
        }
        return nil
    }
}
