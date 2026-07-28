import SwiftUI

/// Compact, app-native auto-review progress. It communicates the current
/// stage without turning background automation into a mascot or obscuring
/// the transcript with a large character illustration.
struct AutoReviewProgressOverlay: View {
    let status: ThreadStatus
    let threadID: String

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
                AutoReviewProgressCard(phase: phase)
                    .transition(
                        .asymmetric(
                            insertion: .opacity.combined(with: .move(edge: .bottom)),
                            removal: .opacity))
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(
                        AutoReviewProgressPresentation.accessibilityLabel(for: phase))
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

    var body: some View {
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

            stageRail
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color(nsColor: .controlBackgroundColor).opacity(0.96))
                .overlay {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(phase.tint.opacity(0.28), lineWidth: 1)
                }
        }
        .shadow(color: .black.opacity(0.14), radius: 10, y: 4)
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
