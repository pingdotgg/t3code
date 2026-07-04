import SwiftUI

/// The compact control strip above the composer input: model picker,
/// runtime-mode picker, plan-mode toggle, and the context-window meter.
struct ComposerControlsRow: View {
    let thread: ChatThread
    let model: AppModel

    var body: some View {
        HStack(spacing: 10) {
            ModelPickerMenu(thread: thread, model: model)
            RuntimeModeMenu(thread: thread, model: model)
            PlanModeToggle(thread: thread, model: model)
            Spacer()
            if let status = model.contextWindows[thread.id] {
                ContextMeterView(status: status)
            }
        }
        .padding(.horizontal, 4)
    }
}

/// Menu listing every (provider instance, model) pair, grouped by provider.
private struct ModelPickerMenu: View {
    let thread: ChatThread
    let model: AppModel

    var body: some View {
        Menu {
            ForEach(ProviderKind.allCases) { kind in
                let options = model.models.filter { $0.provider == kind }
                if !options.isEmpty {
                    Section(kind.displayName) {
                        ForEach(options) { option in
                            Button {
                                Task { await model.setModel(option) }
                            } label: {
                                if isCurrent(option) {
                                    Label(option.displayName, systemImage: "checkmark")
                                } else {
                                    Text(option.displayName)
                                }
                            }
                        }
                    }
                }
            }
        } label: {
            Label(currentModelName, systemImage: "cpu")
                .font(.caption)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .disabled(model.models.isEmpty)
    }

    private func isCurrent(_ option: ModelOption) -> Bool {
        option.instanceID == thread.modelInstanceID && option.modelID == thread.modelID
    }

    private var currentModelName: String {
        if let current = model.models.first(where: isCurrent(_:)) {
            return current.displayName
        }
        return thread.modelID ?? thread.provider.displayName
    }
}

/// Menu selecting how much the agent may do without asking.
private struct RuntimeModeMenu: View {
    let thread: ChatThread
    let model: AppModel

    var body: some View {
        Menu {
            ForEach(ThreadRuntimeMode.allCases) { mode in
                Button {
                    Task { await model.setRuntimeMode(mode) }
                } label: {
                    if mode == thread.runtimeMode {
                        Label(mode.displayName, systemImage: "checkmark")
                    } else {
                        Label(mode.displayName, systemImage: mode.symbolName)
                    }
                }
            }
        } label: {
            Label(thread.runtimeMode.displayName, systemImage: thread.runtimeMode.symbolName)
                .font(.caption)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
    }
}

/// One-tap plan-mode toggle (mirrors the web client's /plan `/default`).
private struct PlanModeToggle: View {
    let thread: ChatThread
    let model: AppModel

    private var isPlan: Bool { thread.interactionMode == .plan }

    var body: some View {
        Button {
            Task { await model.setInteractionMode(isPlan ? .normal : .plan) }
        } label: {
            Label("Plan", systemImage: isPlan ? "list.clipboard.fill" : "list.clipboard")
                .font(.caption)
        }
        .buttonStyle(.plain)
        .foregroundStyle(isPlan ? Color.accentColor : Color.secondary)
        .help(isPlan ? "Plan mode on — the agent proposes a plan instead of editing" : "Turn on plan mode")
    }
}

/// Compact context-window usage meter (ring + percent).
struct ContextMeterView: View {
    let status: ContextWindowStatus

    var body: some View {
        if let fraction = status.usedFraction {
            HStack(spacing: 5) {
                Circle()
                    .trim(from: 0, to: max(0.02, fraction))
                    .stroke(meterColor(fraction), style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .background(Circle().stroke(.quaternary, lineWidth: 2.5))
                    .frame(width: 12, height: 12)
                Text("\(Int((fraction * 100).rounded()))%")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            .help(helpText)
        } else {
            Label("\(status.usedTokens.formatted()) tokens", systemImage: "gauge")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func meterColor(_ fraction: Double) -> Color {
        switch fraction {
        case ..<0.7: .green
        case ..<0.9: .orange
        default: .red
        }
    }

    private var helpText: String {
        if let maxTokens = status.maxTokens {
            return "\(status.usedTokens.formatted()) of \(maxTokens.formatted()) context tokens used"
        }
        return "\(status.usedTokens.formatted()) context tokens used"
    }
}
