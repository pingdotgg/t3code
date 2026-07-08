import SwiftUI

/// Inline account usage-limit stop rendered as a timeline item. The actions
/// send normal follow-up turns because providers do not expose a retry turn API.
public struct UsageLimitCard: View {
    let notice: UsageLimitNotice
    let state: UsageLimitActionState
    let switchModels: [ModelOption]
    let onWait: () -> Void
    let onSwitch: (ModelOption) -> Void
    let onDismiss: () -> Void

    public init(
        notice: UsageLimitNotice,
        state: UsageLimitActionState,
        switchModels: [ModelOption],
        onWait: @escaping () -> Void,
        onSwitch: @escaping (ModelOption) -> Void,
        onDismiss: @escaping () -> Void
    ) {
        self.notice = notice
        self.state = state
        self.switchModels = switchModels
        self.onWait = onWait
        self.onSwitch = onSwitch
        self.onDismiss = onDismiss
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Label("Usage limit reached", systemImage: "hourglass")
                    .font(.callout.weight(.semibold))
                Spacer()
                Button {
                    onDismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.semibold))
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("Dismiss")
            }

            Text(resetLine)
                .font(.callout)
                .foregroundStyle(.secondary)

            if let statusLine {
                Text(statusLine)
                    .font(.caption)
                    .foregroundStyle(statusColor)
            }

            HStack {
                Spacer()
                Button {
                    onWait()
                } label: {
                    Label("Wait", systemImage: "clock")
                }
                .buttonStyle(.glass)
                .disabled(notice.resetsAt == nil || isBusy)

                Menu {
                    ForEach(switchModels) { option in
                        Button {
                            onSwitch(option)
                        } label: {
                            Text(option.displayName)
                        }
                    }
                } label: {
                    Label("Switch model", systemImage: "arrow.left.arrow.right")
                }
                .buttonStyle(.glass)
                .tint(.accentColor)
                .disabled(switchModels.isEmpty || isBusy)
            }
        }
        .padding(14)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 16))
    }

    private var resetLine: String {
        if let resetsAt = notice.resetsAt {
            return "\(notice.providerName) resets at \(timeText(resetsAt))."
        }
        return "\(notice.providerName) reset time unknown."
    }

    private var statusLine: String? {
        switch state {
        case .idle:
            return nil
        case .waiting(let resumeAt):
            return "Resuming at \(timeText(resumeAt))."
        case .resuming:
            return "Resuming now..."
        case .switching(let modelName):
            return "Switching to \(modelName)..."
        case .continued:
            return "Continuation sent."
        case .failed(let message):
            return "Could not continue: \(message)"
        }
    }

    private var statusColor: Color {
        if case .failed = state {
            return .red
        }
        return .secondary
    }

    private var isBusy: Bool {
        switch state {
        case .waiting, .resuming, .switching:
            return true
        case .idle, .continued, .failed:
            return false
        }
    }

    private func timeText(_ date: Date) -> String {
        date.formatted(date: .omitted, time: .shortened)
    }
}
