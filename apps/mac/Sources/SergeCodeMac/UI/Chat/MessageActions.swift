import SwiftUI

// Hover-revealed per-message actions (copy / edit / retry). Shared chrome for
// user bubbles and assistant bodies so the two rows look and behave the same.

/// Compact absolute timestamp used by transcript rows. Keeping the formatter
/// here gives user, tool, and assistant rows one quiet visual treatment and
/// makes the calendar boundary deterministic in tests.
struct TranscriptTimestamp: View {
    let date: Date

    var body: some View {
        Text(Self.text(for: date))
            .font(.caption2)
            .foregroundStyle(.tertiary)
            .monospacedDigit()
            .fixedSize()
    }

    static func text(
        for date: Date,
        relativeTo now: Date = Date(),
        calendar: Calendar = .current
    ) -> String {
        let baseFormat: Date.FormatStyle
        if calendar.isDate(date, inSameDayAs: now) {
            baseFormat = .dateTime.hour().minute()
        } else {
            baseFormat = .dateTime.month(.abbreviated).day().hour().minute()
        }

        var format = baseFormat
        format.calendar = calendar
        format.timeZone = calendar.timeZone
        return date.formatted(format)
    }
}

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
                try? await Task.sleep(for: .seconds(1.5))
                withAnimation(Motion.fade) { didCopy = false }
            }
        }
        .contentTransition(.symbolEffect(.replace))
    }
}

/// Compact material backing for action buttons that float over message
/// content. The buttons stay visually consistent without reserving row height.
struct MessageActionChip<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        HStack(spacing: 2) {
            content
        }
        .padding(.horizontal, 3)
        .padding(.vertical, 2)
        .background(.regularMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(.separator.opacity(0.7), lineWidth: 1))
        .shadow(color: .black.opacity(0.08), radius: 5, y: 2)
    }
}
