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
        // `gap-2.5 rounded-[20px] border p-4`; mobile's spacing unit is 3.5pt (`rem: 14`).
        VStack(alignment: .leading, spacing: 8.75) {
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
            VStack(spacing: 7) {
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
        .padding(14)
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

/// A capsule button in one of mobile's tones: full width and 48pt high, or compact (40pt,
/// sized to its label).
struct ConnButton: View {
    enum Size { case regular, compact }

    let label: String
    let tone: FfiButtonTone
    var size: Size = .regular
    var disabled = false
    var loading = false
    let action: () -> Void

    @Environment(\.connTheme) private var theme

    var body: some View {
        Button(action: action) {
            ZStack {
                Text(label)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(disabled ? theme.mutedForeground : labelColor)
                    .lineLimit(1)
                    .opacity(loading ? 0 : 1)
                if loading {
                    ProgressView().tint(labelColor)
                }
            }
            // `min-h-12 px-6` / compact `min-h-10 px-5`, at 3.5pt per unit.
            .padding(.horizontal, size == .compact ? 17.5 : 21)
            .frame(maxWidth: size == .compact ? nil : .infinity, minHeight: size == .compact ? 35 : 42)
            .background(Capsule().fill(fill))
            .contentShape(Capsule())
        }
        .buttonStyle(PressedOpacityStyle())
        .disabled(disabled || loading)
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
struct PressedOpacityStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.7 : 1)
    }
}

// MARK: - HeightCappedScroll

/// Its content's own height up to `maxHeight`, scrolling past that. `onEdges` hears whether
/// content is scrolled out of view at the top and at the bottom.
struct HeightCappedScroll<Content: View>: View {
    let maxHeight: CGFloat
    let content: Content
    let onEdges: ((Bool, Bool) -> Void)?
    @State private var contentHeight: CGFloat = 0

    init(
        maxHeight: CGFloat,
        @ViewBuilder content: () -> Content,
        onEdges: ((Bool, Bool) -> Void)? = nil
    ) {
        self.maxHeight = maxHeight
        self.content = content()
        self.onEdges = onEdges
    }

    var body: some View {
        ScrollView {
            content.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(height: min(max(contentHeight, 1), maxHeight))
        .onScrollGeometryChange(for: [Bool].self) { geo in
            let offset = geo.contentOffset.y + geo.contentInsets.top
            return [offset > 1, offset + geo.containerSize.height < geo.contentSize.height - 1]
        } action: { _, edges in
            onEdges?(edges[0], edges[1])
        }
    }
}
