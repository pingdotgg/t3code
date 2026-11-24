import DesignKit
import SwiftUI

/// Conn mobile's floating composer pill (`ComposerSurface.tsx`, `ThreadComposer.tsx`): regular
/// Liquid Glass, radius 27, a 44pt control row inside 4×2 padding (48pt tall when collapsed), and
/// a `0 6 28` shadow at 15% black (light) / 35% (dark). It floats over the feed; no band behind it.
struct ConnComposerPill<Trailing: View>: View {
    let placeholder: String
    @Binding var text: String
    var maxLines = 4
    var isBusy = false
    var canSend = false
    let onSend: () -> Void
    var onStop: (() -> Void)?
    @ViewBuilder let trailing: () -> Trailing

    @Environment(\.connTheme) private var theme
    @Environment(\.colorScheme) private var colorScheme

    /// `rounded-[27px]`, `paddingVertical: 2`, `px-1`, and the 44pt control row.
    private static var radius: CGFloat { 27 }
    private static var control: CGFloat { 44 }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Self.radius, style: .continuous)
        // Mobile's `+` (`ComposerAttachmentButton`) stays out until the core sends attachments.
        HStack(alignment: .bottom, spacing: 0) {
            // Body text 16/23 (`useComposerTextStyle(body)`), at least 36 tall, up to four lines.
            TextField(placeholder, text: $text, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.system(size: 16))
                .lineSpacing(4)
                .foregroundStyle(theme.foreground)
                .lineLimit(1...maxLines)
                .padding(.vertical, 10)
                .padding(.leading, 12)
                .frame(maxWidth: .infinity, minHeight: Self.control, alignment: .leading)

            trailing()
                .frame(minHeight: Self.control)

            actionButton
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 2)
        .glassEffect(.regular.interactive(), in: shape)
        .shadow(color: .black.opacity(colorScheme == .dark ? 0.35 : 0.15), radius: 14, y: 6)
    }

    /// Mobile's send button: a 30pt primary circle with `arrow.up` 16 semibold in a 44pt target.
    private var actionButton: some View {
        Button {
            if isBusy { onStop?() } else if canSend { onSend() }
        } label: {
            ZStack {
                Circle()
                    .fill(fill)
                    .frame(width: 30, height: 30)
                if isBusy {
                    KitIconImage(.stop, size: 12)
                        .foregroundStyle(theme.primaryForeground)
                } else {
                    ConnIcon("arrow.up")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(canSend ? theme.primaryForeground : theme.mutedForeground)
                }
            }
            .frame(width: Self.control, height: Self.control)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isBusy ? onStop == nil : !canSend)
        .accessibilityLabel(isBusy ? "Stop" : "Send")
    }

    private var fill: Color {
        if isBusy || canSend { return theme.primary }
        return theme.foreground.opacity(0.08)
    }
}

/// `ComposerModelControl` collapsed (`iconOnly`): the provider icon at 16 and a 10pt chevron in a
/// 44pt target. It opens the thread settings sheet.
struct ConnComposerModelChip: View {
    let driver: String?
    let modelLabel: String?
    let action: () -> Void
    @Environment(\.connTheme) private var theme

    var body: some View {
        Button(action: action) {
            HStack(spacing: 3.5) {
                ProviderIcon(driver: driver, size: 16)
                ConnIcon("chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(theme.mutedForeground)
            }
            .padding(.horizontal, 7)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(modelLabel.map { "Model, \($0)" } ?? "Model")
        .accessibilityIdentifier("composer.modelButton")
    }
}

/// `ProviderIcon`: Claude's mark, Antigravity's image, Grok's package icon, and the knot for every
/// other driver, drawn in `#e5e5e5` (dark) or `#171717` (light).
struct ProviderIcon: View {
    let driver: String?
    var size: CGFloat = 16
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        switch driver?.trimmingCharacters(in: .whitespaces).lowercased() {
        case "claudeagent":
            Image("provider-claude").resizable().scaledToFit().frame(width: size, height: size)
        case "antigravity":
            Image("provider-antigravity").resizable().scaledToFit().frame(width: size, height: size)
        case "grok":
            // `@t3tools/provider-grok/client`'s icon: #F5F5F5 (dark) or #0F0F0F (light).
            Image("provider-grok")
                .resizable()
                .renderingMode(.template)
                .scaledToFit()
                .frame(width: size, height: size)
                .foregroundStyle(colorScheme == .dark ? Color(white: 0.96) : Color(white: 0.059))
        default:
            Image("provider-default")
                .resizable()
                .renderingMode(.template)
                .scaledToFit()
                .frame(width: size, height: size)
                .foregroundStyle(colorScheme == .dark ? Color(white: 0.898) : Color(white: 0.09))
        }
    }
}
