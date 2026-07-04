import SwiftUI

// Floating glass composer — the primary text-entry surface for the selected
// thread. Chrome-only glass; the text itself is typed over an opaque
// TextEditor background so long drafts stay readable.
public struct ComposerBar: View {
    private let model: AppModel

    @UIState private var draft: String = ""

    public init(model: AppModel) {
        self.model = model
    }

    private var trimmedDraft: String {
        draft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canSend: Bool {
        !trimmedDraft.isEmpty && model.connection == .ready
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let thread = model.selectedThread {
                ComposerControlsRow(thread: thread, model: model)
            }

            GlassEffectContainer {
                HStack(alignment: .bottom, spacing: 10) {
                    TextEditor(text: $draft)
                        .font(.body)
                        .scrollContentBackground(.hidden)
                        .frame(minHeight: 22, maxHeight: 120)
                        .fixedSize(horizontal: false, vertical: true)
                        .overlay(alignment: .topLeading) {
                            if draft.isEmpty {
                                Text("Message…")
                                    .foregroundStyle(.tertiary)
                                    .padding(.top, 8)
                                    .padding(.leading, 5)
                                    .allowsHitTesting(false)
                            }
                        }

                    Button {
                        send()
                    } label: {
                        Image(systemName: "paperplane.fill")
                    }
                    .buttonStyle(.glass)
                    .disabled(!canSend)
                    .keyboardShortcut(.return, modifiers: .command)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
            }
            .glassEffect(.regular, in: .rect(cornerRadius: 16))
        }
    }

    private func send() {
        guard canSend else { return }
        let text = trimmedDraft
        draft = ""
        Task { await model.send(text: text) }
    }
}
