import SwiftUI

/// Compact, app-native auto-review progress. It communicates the current
/// stage without turning background automation into a mascot or obscuring
/// the transcript with a large character illustration.
struct AutoReviewProgressOverlay: View {
    let status: ThreadStatus
    let threadID: String
    let activeThreadID: String?
    let onOpenThread: (String) -> Void

    @UIState private var isVisible = false

    private var phase: AutoReviewProgressPhase? {
        AutoReviewProgressPhase(status: status)
    }

    private var token: String {
        "\(threadID)|\(phase?.rawValue ?? "none")"
    }

    var body: some View {
        Group {
            if let phase, isVisible {
                AutoReviewProgressCard(
                    phase: phase,
                    canOpenThread: activeThreadID != nil,
                    onOpenThread: {
                        guard let activeThreadID else { return }
                        Haptics.play(.selection)
                        onOpenThread(activeThreadID)
                    })
                    .transition(
                        .asymmetric(
                            insertion: .opacity.combined(with: .move(edge: .bottom)),
                            removal: .opacity))
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(
                        AutoReviewProgressPresentation.accessibilityLabel(for: phase))
                    .accessibilityHint(
                        activeThreadID == nil ? "" : "Opens the active auto-fixer thread")
                    #if DEBUG
                        .probeSurface(
                            UIProbeSurfaces.autoReviewProgress,
                            threadID: threadID,
                            detail: phase.rawValue)
                    #endif
            }
        }
        .task(id: token) { await updateVisibility() }
    }

    private func updateVisibility() async {
        guard let phase else {
            withAnimation(Motion.reveal) { isVisible = false }
            return
        }
        withAnimation(Motion.reduceMotion ? Motion.reveal : Motion.structure) {
            isVisible = true
        }
        guard let dwell = AutoReviewProgressPresentation.dwell(for: phase) else { return }
        try? await Task.sleep(for: .seconds(dwell))
        guard !Task.isCancelled else { return }
        withAnimation(Motion.reveal) { isVisible = false }
    }
}

private struct AutoReviewProgressCard: View {
    let phase: AutoReviewProgressPhase
    let canOpenThread: Bool
    let onOpenThread: () -> Void

    @UIState private var isHovering = false

    var body: some View {
        Group {
            if canOpenThread {
                Button(action: onOpenThread) {
                    cardContent
                }
                .buttonStyle(.plain)
                .help("Open the auto-fixer thread")
            } else {
                cardContent
            }
        }
        .onHover { isHovering = $0 }
        .animation(Motion.feedback, value: isHovering)
    }

    private var cardContent: some View {
        HStack(spacing: 11) {
            stageIcon

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(AutoReviewProgressPresentation.title)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text("·")
                        .foregroundStyle(.tertiary)
                    Text(AutoReviewProgressPresentation.headline(for: phase))
                        .font(.caption.weight(.semibold))
                }
                Text(AutoReviewProgressPresentation.detail(for: phase))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            VStack(alignment: .trailing, spacing: 5) {
                stageRail
                if canOpenThread,
                    let action = AutoReviewProgressPresentation.actionLabel(for: phase)
                {
                    HStack(spacing: 3) {
                        Text(action)
                        Image(systemName: "arrow.up.right")
                    }
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(phase.tint)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color(nsColor: .controlBackgroundColor).opacity(0.96))
                .overlay {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(
                            phase.tint.opacity(isHovering && canOpenThread ? 0.56 : 0.28),
                            lineWidth: 1)
                }
        }
        .shadow(
            color: .black.opacity(isHovering && canOpenThread ? 0.2 : 0.14),
            radius: isHovering && canOpenThread ? 13 : 10,
            y: 4)
        .scaleEffect(isHovering && canOpenThread ? 1.012 : 1)
        .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var stageIcon: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(phase.tint.opacity(0.14))
            Image(systemName: AutoReviewProgressPresentation.symbolName(for: phase))
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(phase.tint)
                .symbolEffect(
                    .pulse.byLayer,
                    options: .repeating,
                    isActive: !Motion.reduceMotion && phase != .readyToMerge)
        }
        .frame(width: 30, height: 30)
    }

    private var stageRail: some View {
        HStack(spacing: 4) {
            ForEach(0..<3, id: \.self) { index in
                Capsule()
                    .fill(index <= phase.stepIndex ? phase.tint : Color.secondary.opacity(0.2))
                    .frame(width: index == phase.stepIndex ? 14 : 6, height: 5)
            }
        }
        .animation(Motion.reduceMotion ? nil : Motion.structure, value: phase)
        .help("Review · Fix · Clear")
    }
}

private extension AutoReviewProgressPhase {
    var tint: Color {
        switch self {
        case .reviewing: .cyan
        case .fixing: .orange
        case .readyToMerge: .green
        }
    }
}
