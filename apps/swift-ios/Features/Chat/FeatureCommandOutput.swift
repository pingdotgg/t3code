import SwiftUI
import UIKit

@MainActor
protocol FeatureCommandOutputStreaming: AnyObject {
    /// Nil selects final-output inspection on servers without this capability.
    func commandOutput(threadID: String, source: OrchestrationV2TimelineMetadata)
        async throws -> AsyncThrowingStream<CommandOutputFrame, Error>?
}

@MainActor
final class FeatureCommandOutputState: ObservableObject {
    enum Phase: Equatable { case loading, unsupported, streaming, failed(String) }
    @Published private(set) var phase: Phase = .loading
    @Published private(set) var output: CommandOutputState?
    private var generation = UUID()

    func reset() {
        generation = UUID()
        output = nil
        phase = .loading
    }

    /// The expanded row owns the task. No task or live output enters the timeline cache.
    func observe(client: any FeatureCommandOutputStreaming, threadID: String,
                 source: OrchestrationV2TimelineMetadata) async -> Bool {
        reset()
        let lease = generation
        do {
            guard let stream = try await client.commandOutput(threadID: threadID, source: source) else {
                guard generation == lease, !Task.isCancelled else { return true }
                phase = .unsupported
                return false
            }
            guard generation == lease, !Task.isCancelled else { return true }
            phase = .streaming
            var next = CommandOutputState()
            var received = false
            for try await frame in stream {
                guard generation == lease, !Task.isCancelled else { return true }
                guard received || frame.kind == .replace else {
                    throw RPCError.protocolViolation("Command output must start with a replacement frame.")
                }
                received = true
                next.apply(frame)
                output = next
                if !frame.running { return true }
            }
            guard generation == lease, !Task.isCancelled else { return true }
            throw RPCError.protocolViolation("Command output ended before the final frame.")
        } catch {
            guard generation == lease, !Task.isCancelled else { return true }
            phase = .failed(error.localizedDescription)
            return true
        }
    }
}

struct FeatureCommandOutputView: View {
    @ObservedObject var state: FeatureCommandOutputState
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let output = state.output {
                if output.truncated { Text("Earlier output not shown") }
                if !output.text.isEmpty {
                    FeatureCommandOutputText(spans: output.spans)
                        .frame(height: 240)
                } else if !output.running { Text("No output.") }
            } else if state.phase == .loading || state.phase == .streaming {
                Text("Loading output…")
            }
            if case let .failed(message) = state.phase {
                Text("Could not load output: \(message)").foregroundStyle(T3Colors.danger)
                Button("Retry", action: retry).buttonStyle(.plain)
            }
        }
        .font(T3Typography.tool)
    }
}

/// Text layout and scroll following run only when frames arrive.
private struct FeatureCommandOutputText: UIViewRepresentable {
    let spans: [CommandOutputState.Span]

    final class Coordinator {
        var spans: [CommandOutputState.Span] = []
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.alwaysBounceVertical = false
        view.accessibilityIdentifier = "command-output"
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        guard context.coordinator.spans != spans else { return }
        let follows = view.contentSize.height - view.contentOffset.y - view.bounds.height <= 8
        context.coordinator.spans = spans
        let text = NSMutableAttributedString(string: "")
        for span in spans {
            var traits: UIFontDescriptor.SymbolicTraits = []
            if span.style.bold { traits.insert(.traitBold) }
            if span.style.italic { traits.insert(.traitItalic) }
            let base = UIFont.monospacedSystemFont(ofSize: 13, weight: .regular)
            let font = base.fontDescriptor.withSymbolicTraits(traits).map { UIFont(descriptor: $0, size: 13) } ?? base
            var foreground = color(span.style.foreground, fallback: .white)
            var background = color(span.style.background, fallback: .black)
            if span.style.inverse { swap(&foreground, &background) }
            var attributes: [NSAttributedString.Key: Any] = [
                .font: font, .foregroundColor: foreground.withAlphaComponent(span.style.dim ? 0.6 : 1),
                .backgroundColor: background,
            ]
            if span.style.underline { attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue }
            if span.style.strike { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            text.append(NSAttributedString(string: span.text, attributes: attributes))
        }
        let offset = view.contentOffset
        view.attributedText = text
        view.layoutIfNeeded()
        view.setContentOffset(follows
            ? CGPoint(x: 0, y: max(0, view.contentSize.height - view.bounds.height)) : offset, animated: false)
    }

    private func color(_ color: CommandOutputStyle.Color?, fallback: UIColor) -> UIColor {
        guard let color else { return fallback }
        switch color {
        case let .rgb(red, green, blue):
            return UIColor(red: CGFloat(red) / 255, green: CGFloat(green) / 255, blue: CGFloat(blue) / 255, alpha: 1)
        case let .indexed(index):
            if index < 16 {
                let palette: [UInt32] = [
                    0x000000, 0xCD3131, 0x0DBC79, 0xE5E510, 0x2472C8, 0xBC3FBC, 0x11A8CD, 0xE5E5E5,
                    0x666666, 0xF14C4C, 0x23D18B, 0xF5F543, 0x3B8EEA, 0xD670D6, 0x29B8DB, 0xFFFFFF,
                ]
                let rgb = palette[max(0, index)]
                return UIColor(red: CGFloat((rgb >> 16) & 255) / 255,
                               green: CGFloat((rgb >> 8) & 255) / 255, blue: CGFloat(rgb & 255) / 255, alpha: 1)
            }
            if index >= 232 { return UIColor(white: CGFloat(8 + (index - 232) * 10) / 255, alpha: 1) }
            let cube = index - 16
            let levels: [CGFloat] = [0, 95, 135, 175, 215, 255]
            return UIColor(red: levels[cube / 36] / 255, green: levels[(cube / 6) % 6] / 255,
                           blue: levels[cube % 6] / 255, alpha: 1)
        }
    }
}
