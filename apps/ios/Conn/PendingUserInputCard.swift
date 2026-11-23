import SwiftUI
import UIKit

// MARK: - PendingUserInputCard (1:1 port of PendingUserInputCard.tsx)

/// The question the agent waits for, above the composer: the question, the agent's context,
/// the options and the step controls. What it shows comes from Rust (`conn-ffi` `questions`);
/// this view draws it and reports taps.
struct PendingUserInputCard: View {
    let question: FfiPendingQuestion
    let panel: FfiQuestionPanel
    /// The answers are on their way.
    let responding: Bool
    /// The pick about to move on; its Next button stays hidden meanwhile.
    let advancing: Bool
    let maxHeight: CGFloat
    let onSelectOption: (String) -> Void
    let onStepChange: (Int) -> Void
    let onSubmit: () -> Void
    let onDismiss: () -> Void

    @Environment(\.connTheme) private var theme
    @State private var contextExpanded = false
    @State private var footerHeight: CGFloat = 0
    @State private var hiddenTop = false
    @State private var hiddenBottom = false

    private static let sheetRadius: CGFloat = 28
    private static let fadeHeight: CGFloat = 24
    /// A trailing text button ends at the 20pt text edge instead of the panel's 8pt edge.
    private static let textActionLastMargin: CGFloat = 12

    private var showNext: Bool { panel.showNext && !advancing }
    private var lastIsText: Bool { !panel.showSend && !showNext }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            scrollArea
            if let notice = panel.notice {
                Text(notice)
                    .font(.system(size: 13))
                    .lineSpacing(3)
                    .foregroundStyle(theme.mutedForeground)
            }
            if panel.showFooter {
                footer
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { footerHeight = $0 }
            }
        }
        .padding(.top, 16)
        .padding(.leading, 20)
        .padding(.trailing, 8)
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Self.sheetRadius, style: .continuous).fill(theme.card)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Self.sheetRadius, style: .continuous)
                .strokeBorder(theme.border, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("thread.question.\(question.requestId)")
    }

    // MARK: Scroll area

    /// One content column from the 8pt edge on both sides. Text sits 12pt in (the 20pt inset);
    /// option highlights extend back out to the edge.
    private var scrollArea: some View {
        let scrollMax = max(60, maxHeight - 24 - footerHeight - (panel.notice == nil ? 0 : 48))
        return HeightCappedScroll(maxHeight: scrollMax) {
            VStack(alignment: .leading, spacing: 8) {
                MarkdownView(source: panel.question)
                if let markdown = question.contextMarkdown, let preview = question.contextPreview {
                    AgentContext(
                        markdown: markdown,
                        preview: preview,
                        expanded: contextExpanded,
                        onToggle: { contextExpanded.toggle() }
                    )
                }
                if !panel.options.isEmpty || panel.customAnswer != nil {
                    // 4pt more than the text gap: the highlight has no text leading.
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(panel.options, id: \.value) { option in
                            optionView(option)
                        }
                        if let custom = panel.customAnswer {
                            OptionRow(
                                selected: true,
                                multiple: panel.multiSelect,
                                disabled: true,
                                dimmed: panel.dimmed,
                                recommended: false,
                                action: {}
                            ) {
                                Text("Your answer")
                                    .font(.system(size: 12, weight: .medium))
                                    .foregroundStyle(theme.mutedForeground)
                                Text(custom)
                                    .font(.system(size: 14))
                                    .foregroundStyle(theme.foreground)
                            }
                        }
                    }
                    .padding(.horizontal, -12)
                    .padding(.top, 4)
                }
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 4)
        } onEdges: { top, bottom in
            hiddenTop = top
            hiddenBottom = bottom
        }
        .id(panel.questionId)
        .padding(.leading, -12)
        .overlay(alignment: .top) {
            if hiddenTop { ScrollEdgeFade(edge: .top, color: theme.card) }
        }
        .overlay(alignment: .bottom) {
            if hiddenBottom { ScrollEdgeFade(edge: .bottom, color: theme.card) }
        }
    }

    @ViewBuilder
    private func optionView(_ option: FfiQuestionPanelOption) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            OptionRow(
                selected: option.selected,
                multiple: panel.multiSelect,
                disabled: panel.optionsDisabled,
                dimmed: panel.dimmed,
                recommended: option.recommended,
                action: { onSelectOption(option.value) }
            ) {
                Text(option.label)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(theme.foreground)
                if let description = option.description {
                    Text(description)
                        .font(.system(size: 13))
                        .foregroundStyle(theme.mutedForeground)
                }
            }
            .accessibilityIdentifier("question.option.\(option.label)")
            if let preview = option.preview {
                MarkdownView(source: preview)
                    .padding(.bottom, 12)
                    .padding(.leading, 44)
                    .padding(.trailing, 12)
            }
        }
    }

    // MARK: Footer

    /// The progress keeps the 20pt text inset; a last pill ends at the 8pt edge, a last text
    /// button at the text edge.
    private var footer: some View {
        HStack(spacing: 20) {
            if let progress = panel.progress {
                Text(progress)
                    .font(.system(size: 13))
                    .foregroundStyle(theme.mutedForeground)
            }
            Spacer(minLength: 0)
            if panel.showSkip {
                TextAction(
                    label: "Skip",
                    accessibilityLabel: "Skip question without answering",
                    disabled: panel.skipDisabled,
                    action: onDismiss
                )
                .padding(.trailing, panel.showSkip && lastIsText && !panel.showBack ? Self.textActionLastMargin : 0)
            }
            if panel.showBack {
                TextAction(
                    label: "Back",
                    accessibilityLabel: "Previous question",
                    disabled: panel.backDisabled,
                    action: { onStepChange(Int(panel.step) - 1) }
                )
                .padding(.trailing, lastIsText ? Self.textActionLastMargin : 0)
            }
            if panel.showSend {
                ConnButton(
                    label: "Send",
                    tone: .primary,
                    size: .compact,
                    disabled: panel.sendDisabled,
                    loading: responding,
                    action: onSubmit
                )
                .fixedSize()
                .accessibilityLabel("Send answers")
                .accessibilityIdentifier("question.send")
            }
            if showNext {
                ConnButton(
                    label: "Next",
                    tone: .primary,
                    size: .compact,
                    disabled: panel.nextDisabled,
                    action: { onStepChange(Int(panel.step) + 1) }
                )
                .fixedSize()
                .accessibilityLabel("Next question")
                .accessibilityIdentifier("question.next")
            }
        }
        .frame(minHeight: 40)
    }
}

// MARK: - AgentContext

/// What the agent wrote just before asking: muted, three lines with an inline "… Show more".
private struct AgentContext: View {
    let markdown: String
    let preview: String
    let expanded: Bool
    let onToggle: () -> Void

    @Environment(\.connTheme) private var theme
    @State private var width: CGFloat = 0

    private static let fontSize: CGFloat = 15
    private static let lineSpacing: CGFloat = 4

    /// Where the preview stops, measured at the panel's width; `nil` when it fits.
    private var clamped: String? {
        guard width > 0 else { return nil }
        return questionContextClamp(
            preview: preview,
            fits: ThreeLineFit(width: width, fontSize: Self.fontSize, lineSpacing: Self.lineSpacing)
        )
    }

    var body: some View {
        let clamped = clamped
        Group {
            if expanded || (width > 0 && clamped == nil) {
                VStack(alignment: .leading, spacing: 4) {
                    MarkdownView(source: markdown, muted: true)
                    if expanded && clamped != nil {
                        toggle("Show less")
                    }
                }
            } else if let clamped {
                let more = Text("Show more").fontWeight(.medium).foregroundStyle(theme.foreground)
                Text("\(Text(clamped + "… ").foregroundStyle(theme.mutedForeground))\(more)")
                    .font(.system(size: Self.fontSize))
                    .lineSpacing(Self.lineSpacing)
                    .onTapGesture(perform: onToggle)
                    .accessibilityAddTraits(.isButton)
                    .accessibilityHint("Show more")
            } else {
                Text(preview)
                    .font(.system(size: Self.fontSize))
                    .lineSpacing(Self.lineSpacing)
                    .foregroundStyle(theme.mutedForeground)
                    .lineLimit(3)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    }

    private func toggle(_ label: String) -> some View {
        Button(action: onToggle) {
            Text(label)
                .font(.system(size: Self.fontSize, weight: .medium))
                .foregroundStyle(theme.foreground)
        }
        .buttonStyle(.plain)
    }
}

/// Tells Rust's clamp whether a candidate fits three lines of the context's font at `width`.
private final class ThreeLineFit: FfiTextFits, @unchecked Sendable {
    private let width: CGFloat
    private let font: UIFont
    private let mediumFont: UIFont
    private let lineSpacing: CGFloat

    init(width: CGFloat, fontSize: CGFloat, lineSpacing: CGFloat) {
        self.width = width
        self.font = .systemFont(ofSize: fontSize)
        self.mediumFont = .systemFont(ofSize: fontSize, weight: .medium)
        self.lineSpacing = lineSpacing
    }

    func fits(text: String, withMore: Bool) -> Bool {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = lineSpacing
        let string = NSMutableAttributedString(
            string: text,
            attributes: [.font: font, .paragraphStyle: paragraph]
        )
        if withMore {
            string.append(NSAttributedString(string: "… ", attributes: [.font: font, .paragraphStyle: paragraph]))
            string.append(NSAttributedString(string: "Show more", attributes: [.font: mediumFont, .paragraphStyle: paragraph]))
        }
        let height = string.boundingRect(
            with: CGSize(width: width, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            context: nil
        ).height
        let threeLines = font.lineHeight * 3 + lineSpacing * 2
        return ceil(height) <= ceil(threeLines) + 1
    }
}

// MARK: - Option rows

/// A radio (single choice) or a checkbox (several).
private struct SelectionMark: View {
    let selected: Bool
    let multiple: Bool

    @Environment(\.connTheme) private var theme

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: multiple ? 6 : 10, style: .circular)
        ZStack {
            if selected {
                shape.fill(theme.primary)
                if multiple {
                    SmallCheck().fill(theme.primaryForeground).frame(width: 14, height: 14)
                } else {
                    Circle().fill(theme.primaryForeground).frame(width: 8, height: 8)
                }
            } else {
                shape.strokeBorder(theme.mutedForeground, lineWidth: 1.5)
            }
        }
        .frame(width: 20, height: 20)
    }
}

/// The 16px solid check, drawn for small sizes; the 24px glyph turns hairline this small.
private struct SmallCheck: Shape {
    func path(in rect: CGRect) -> Path {
        let scale = min(rect.width, rect.height) / 16
        var path = Path()
        path.move(to: CGPoint(x: 12.416, y: 3.376))
        path.addCurve(to: CGPoint(x: 12.624, y: 4.416), control1: CGPoint(x: 12.761, y: 3.606), control2: CGPoint(x: 12.854, y: 4.071))
        path.addLine(to: CGPoint(x: 7.624, y: 11.916))
        path.addCurve(to: CGPoint(x: 6.47, y: 12.03), control1: CGPoint(x: 7.359, y: 12.313), control2: CGPoint(x: 6.807, y: 12.367))
        path.addLine(to: CGPoint(x: 3.47, y: 9.03))
        path.addCurve(to: CGPoint(x: 4.53, y: 7.97), control1: CGPoint(x: 2.762, y: 8.322), control2: CGPoint(x: 3.822, y: 7.262))
        path.addLine(to: CGPoint(x: 6.883, y: 10.323))
        path.addLine(to: CGPoint(x: 11.376, y: 3.583))
        path.addCurve(to: CGPoint(x: 12.416, y: 3.376), control1: CGPoint(x: 11.606, y: 3.239), control2: CGPoint(x: 12.071, y: 3.146))
        path.closeSubpath()
        return path.applying(CGAffineTransform(scaleX: scale, y: scale))
    }
}

private struct OptionRow<Content: View>: View {
    let selected: Bool
    let multiple: Bool
    let disabled: Bool
    let dimmed: Bool
    /// The "Recommended" pill sits on its own line above the title.
    let recommended: Bool
    let action: () -> Void
    @ViewBuilder let content: Content

    @Environment(\.connTheme) private var theme

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 6) {
                if recommended {
                    // Indented to the title column: mark width (20) + gap (12).
                    Text("Recommended")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(theme.primary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 1)
                        .background(Capsule().fill(theme.primary.opacity(0.15)))
                        .padding(.leading, 32)
                }
                HStack(alignment: .top, spacing: 12) {
                    SelectionMark(selected: selected, multiple: multiple)
                    VStack(alignment: .leading, spacing: 4) {
                        content
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .multilineTextAlignment(.leading)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(OptionRowStyle(selected: selected))
        .disabled(disabled)
        .opacity(dimmed ? 0.5 : 1)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// `bg-foreground/6` when selected, `active:bg-foreground/5` when pressed.
private struct OptionRowStyle: ButtonStyle {
    let selected: Bool
    @Environment(\.connTheme) private var theme

    func makeBody(configuration: Configuration) -> some View {
        configuration.label.background(
            RoundedRectangle(cornerRadius: 16, style: .continuous).fill(
                theme.foreground.opacity(selected ? 0.06 : configuration.isPressed ? 0.05 : 0)
            )
        )
    }
}

/// Skip and Back: text with no padding of its own, so the row can end flush.
private struct TextAction: View {
    let label: String
    let accessibilityLabel: String
    let disabled: Bool
    let action: () -> Void

    @Environment(\.connTheme) private var theme

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(theme.mutedForeground)
                .contentShape(Rectangle().inset(by: -11))
        }
        .buttonStyle(PressedOpacityStyle())
        .disabled(disabled)
        .accessibilityLabel(accessibilityLabel)
    }
}

/// Fades scrolled-away content into the panel's fill, so it is not sliced at the scroll edge.
private struct ScrollEdgeFade: View {
    enum Edge { case top, bottom }
    let edge: Edge
    let color: Color

    var body: some View {
        LinearGradient(
            colors: edge == .top ? [color, color.opacity(0)] : [color.opacity(0), color],
            startPoint: .top,
            endPoint: .bottom
        )
        .frame(height: 24)
        .allowsHitTesting(false)
    }
}
