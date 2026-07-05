import SwiftUI

// Hover-revealed per-message actions (copy / edit / retry). Shared chrome for
// user bubbles and assistant bodies so the two rows look and behave the same.

/// Small icon button used in message action rows.
struct MessageActionButton: View {
    let systemImage: String
    let help: String
    var tint: Color = .secondary
    var disabled: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.caption)
                .frame(width: 22, height: 20)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(tint)
        .disabled(disabled)
        .opacity(disabled ? 0.4 : 1)
        .help(help)
    }
}

/// Copy button with transient checkmark feedback.
struct CopyActionButton: View {
    let text: String

    @UIState private var didCopy = false

    var body: some View {
        MessageActionButton(
            systemImage: didCopy ? "checkmark" : "doc.on.doc",
            help: "Copy text",
            tint: didCopy ? .green : .secondary
        ) {
            guard !didCopy else { return }
            Pasteboard.copy(text)
            withAnimation(Motion.snap) { didCopy = true }
            Task {
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                withAnimation(Motion.fade) { didCopy = false }
            }
        }
        .contentTransition(.symbolEffect(.replace))
    }
}
