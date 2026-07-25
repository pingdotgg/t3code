import SwiftUI

// Hover-revealed per-message actions (copy / edit / retry). Shared chrome for
// user bubbles and assistant bodies so the two rows look and behave the same.

/// Compact absolute timestamp used by transcript rows. Keeping the formatter
/// here gives user, tool, and assistant rows one quiet visual treatment and
/// makes the calendar boundary deterministic in tests.
struct TranscriptTimestamp: View {
    private let label: String

    init(date: Date) {
        // Cache formatting in the view value so body re-evaluation does not
        // rebuild a Date.FormatStyle for the same event timestamp.
        self.label = Self.text(for: date)
    }

    var body: some View {
        Text(label)
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
        } else if calendar.component(.year, from: date)
            != calendar.component(.year, from: now)
        {
            baseFormat = .dateTime.month(.abbreviated).day().year().hour().minute()
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
        .buttonStyle(MessageActionButtonStyle())
        .foregroundStyle(tint)
        .disabled(disabled)
        .opacity(disabled ? 0.4 : 1)
        .help(help)
        .accessibilityLabel(help)
    }
}

/// Press/hover feedback for the compact message-action icons: a small scale
/// dip while pressed and a gentle brightness lift under the pointer. Render
/// transforms only, so they are safe on rows inside the streaming timeline.
private struct MessageActionButtonStyle: ButtonStyle {
    @UIState private var isHovered = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
            .brightness(isHovered ? 0.08 : 0)
            .animation(Motion.feedback, value: configuration.isPressed)
            .animation(Motion.feedback, value: isHovered)
            .onHover { isHovered = $0 }
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
            withAnimation(Motion.feedback) { didCopy = true }
            Task {
                try? await Task.sleep(for: .seconds(1.5))
                withAnimation(Motion.reveal) { didCopy = false }
            }
        }
        .contentTransition(
            Motion.reduceMotion ? .identity : .symbolEffect(.replace))
    }
}

/// Compact floating backing for action buttons that sit over message content.
/// An opaque dark capsule (not a material): materials blend with whatever is
/// behind them in-window, which washed the chip out to near-invisible over
/// light surfaces. The solid fill keeps the icons legible over any bubble.
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
        .background(Color(nsColor: .windowBackgroundColor), in: Capsule())
        .overlay(Capsule().strokeBorder(.white.opacity(0.14), lineWidth: 1))
        .shadow(color: .black.opacity(0.35), radius: 6, y: 2)
    }
}
