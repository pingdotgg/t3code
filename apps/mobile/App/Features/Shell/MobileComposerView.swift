import SwiftUI

struct MobileComposerView: View {
    @Binding var text: String
    let canSend: Bool
    let isSending: Bool
    let onSend: () -> Void

    var body: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField("Message T3 Code", text: $text, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...6)
                .disabled(!canSend)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .accessibilityHint(canSend ? "Enter a message to send to the selected thread." : "Connect to a configured mobile sync server before sending messages.")

            Button {
                onSend()
            } label: {
                if isSending {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                }
            }
            .buttonStyle(.plain)
            .disabled(!canSend || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityLabel("Send message")
        }
        .padding(10)
        .background(.ultraThinMaterial)
    }
}

#Preview {
    @Previewable @State var text = "Continue"
    MobileComposerView(text: $text, canSend: true, isSending: false) {}
}
