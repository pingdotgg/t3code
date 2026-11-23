import SwiftUI

// MARK: - PendingApprovalCard (1:1 port of PendingApprovalCard.tsx)

/// The approval the agent waits for, above the composer: what it asks and the answers.
/// Its content comes from Rust (`conn-ffi` `approvals`); this view only draws it.
struct PendingApprovalCard: View {
    let approval: FfiPendingApproval
    /// An answer for this approval is on its way.
    let responding: Bool
    let onRespond: (FfiApprovalDecision) -> Void

    @Environment(\.connTheme) private var theme
    @State private var explanationOpen = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("APPROVAL NEEDED")
                .font(.system(size: 12, weight: .bold))
                .tracking(1.1)
                .foregroundStyle(theme.mutedForeground)
            Text(approval.title)
                .font(.system(size: 18, weight: .bold))
                .foregroundStyle(theme.foreground)
            if let detail = approval.detail {
                Text(detail)
                    .font(.system(size: 14))
                    .lineSpacing(3)
                    .foregroundStyle(theme.mutedForeground)
                    .textSelection(.enabled)
            }
            if let reason = approval.reason {
                Text(reason)
                    .font(.system(size: 13))
                    .lineSpacing(3)
                    .foregroundStyle(theme.warning)
            }
            if let explanation = approval.fullAccessExplanation {
                Button {
                    explanationOpen.toggle()
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Why am I being asked this?")
                            .font(.system(size: 13, weight: .bold))
                            .underline()
                            .foregroundStyle(theme.mutedForeground)
                        if explanationOpen {
                            Text(explanation)
                                .font(.system(size: 13))
                                .lineSpacing(3)
                                .foregroundStyle(theme.mutedForeground)
                                .multilineTextAlignment(.leading)
                        }
                    }
                }
                .buttonStyle(.plain)
                .accessibilityValue(explanationOpen ? "Expanded" : "Collapsed")
            }
            if !approval.answerable {
                Text(
                    "The provider process for this request is no longer available. Interrupt or restart the run to continue."
                )
                .font(.system(size: 14))
                .foregroundStyle(theme.mutedForeground)
                .accessibilityIdentifier("approval.notAnswerable")
            }
            if let warning = approval.warning {
                Text(warning)
                    .font(.system(size: 13))
                    .lineSpacing(3)
                    .foregroundStyle(theme.warning)
            }
            VStack(spacing: 8) {
                ForEach(approval.options, id: \.decision) { option in
                    ConnButton(
                        label: option.label,
                        tone: option.tone,
                        disabled: !approval.answerable || responding
                    ) {
                        onRespond(option.decision)
                    }
                    .accessibilityIdentifier("approval.option.\(option.label)")
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(theme.card))
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .strokeBorder(theme.border, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("thread.approval.\(approval.requestId)")
    }
}

// MARK: - ConnButton (port of mobile's ui/Button)

/// A full-width capsule button, 48pt high, in one of mobile's tones.
struct ConnButton: View {
    let label: String
    let tone: FfiButtonTone
    var disabled = false
    let action: () -> Void

    @Environment(\.connTheme) private var theme

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(disabled ? theme.mutedForeground : labelColor)
                .lineLimit(1)
                .padding(.horizontal, 24)
                .frame(maxWidth: .infinity, minHeight: 48)
                .background(Capsule().fill(fill))
                .contentShape(Capsule())
        }
        .buttonStyle(PressedOpacityStyle())
        .disabled(disabled)
    }

    private var fill: Color {
        switch tone {
        case .primary: theme.primary
        case .secondary: theme.secondary
        case .danger: theme.destructive.opacity(0.12)
        }
    }

    private var labelColor: Color {
        switch tone {
        case .primary: theme.primaryForeground
        case .secondary: theme.foreground
        case .danger: theme.destructive
        }
    }
}

/// `active:opacity-70`.
private struct PressedOpacityStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.7 : 1)
    }
}

// MARK: - HeightCappedScroll

/// Its content's own height up to `maxHeight`, scrolling past that.
struct HeightCappedScroll<Content: View>: View {
    let maxHeight: CGFloat
    @ViewBuilder let content: Content
    @State private var contentHeight: CGFloat = 0

    var body: some View {
        ScrollView {
            content.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(height: min(max(contentHeight, 1), maxHeight))
    }
}
