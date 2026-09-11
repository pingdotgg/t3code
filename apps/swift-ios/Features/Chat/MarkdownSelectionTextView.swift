import UIKit
import SwiftUI

extension NSAttributedString.Key {
    static let markdownCodeCard = Self("t3.markdown.code-card")
}

final class MarkdownCodeCard: NSObject {
    let code: String
    let language: String?
    let indent: CGFloat
    static let headerHeight: CGFloat = 44
    static let padding: CGFloat = 13

    init(code: String, language: String?, indent: CGFloat) {
        self.code = code
        self.language = language
        self.indent = indent
    }

    /// Invisible attachments reserve header/footer space in the same text layout.
    /// They are excluded from selection-copy; only the code contributes Markdown.
    @MainActor
    func decorate(_ codeText: NSMutableAttributedString) {
        let header = spacer(height: Self.headerHeight)
        header.append(NSAttributedString(string: "\n", attributes: header.attributes(at: 0, effectiveRange: nil)))
        let headerStyle = NSMutableParagraphStyle()
        headerStyle.paragraphSpacing = Self.padding
        header.addAttribute(.paragraphStyle, value: headerStyle, range: NSRange(location: 0, length: header.length))
        codeText.insert(header, at: 0)
        let footer = spacer(height: Self.padding)
        footer.insert(NSAttributedString(string: "\n", attributes: [
            .font: UIFont.systemFont(ofSize: 1),
            .markdownCopyDecoration: true,
        ]), at: 0)
        codeText.append(footer)
        codeText.addAttribute(.markdownCodeCard, value: self, range: NSRange(location: 0, length: codeText.length))
    }

    @MainActor
    private func spacer(height: CGFloat) -> NSMutableAttributedString {
        let attachment = NSTextAttachment()
        attachment.image = UIGraphicsImageRenderer(size: CGSize(width: 1, height: 1)).image { _ in }
        attachment.bounds = CGRect(x: 0, y: 0, width: 1, height: height)
        let text = NSMutableAttributedString(attachment: attachment)
        text.addAttributes([
            .font: UIFont.systemFont(ofSize: 1),
            .markdownCopyDecoration: true,
        ], range: NSRange(location: 0, length: text.length))
        return text
    }
}

/// Code text belongs to the native selection. Cards sit behind it, with controls
/// over the reserved header space rather than inside a separate selectable view.
final class MarkdownSelectionTextView: FeatureInlineSkillTextView {
    private struct CardViews {
        let card: MarkdownCodeCard
        let range: NSRange
        let background: UIView
        let header: MarkdownCodeHeaderView
    }

    private var cards: [CardViews] = []
    private var ownedTextStorage: NSTextStorage?

    override init(frame: CGRect, textContainer: NSTextContainer?) {
        let container: NSTextContainer
        if let textContainer {
            container = textContainer
        } else {
            let storage = NSTextStorage()
            ownedTextStorage = storage
            let manager = NSLayoutManager()
            container = NSTextContainer(size: .zero)
            storage.addLayoutManager(manager)
            manager.addTextContainer(container)
        }
        super.init(frame: frame, textContainer: container)
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: MarkdownSelectionTextView, _: UITraitCollection) in
            view.updateCardColors()
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var attributedText: NSAttributedString! {
        didSet { rebuildCards() }
    }

    override func copy(_ sender: Any?) {
        guard let markdown = MarkdownSelectionCopy.markdown(in: attributedText, range: selectedRange) else {
            super.copy(sender)
            return
        }
        UIPasteboard.general.string = markdown
    }

    private func rebuildCards() {
        for views in cards {
            views.background.removeFromSuperview()
            views.header.removeFromSuperview()
        }
        cards.removeAll(keepingCapacity: true)
        guard let text = attributedText else { return }
        text.enumerateAttribute(.markdownCodeCard, in: NSRange(location: 0, length: text.length)) { value, range, _ in
            guard let card = value as? MarkdownCodeCard else { return }
            let background = UIView()
            background.isUserInteractionEnabled = false
            background.layer.cornerRadius = 10
            background.layer.borderWidth = 1
            insertSubview(background, at: 0)
            let header = MarkdownCodeHeaderView(card: card)
            addSubview(header)
            cards.append(CardViews(card: card, range: range, background: background, header: header))
        }
        updateCardColors()
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard !cards.isEmpty else { return }
        layoutManager.ensureLayout(for: textContainer)
        for views in cards {
            let glyphs = layoutManager.glyphRange(forCharacterRange: views.range, actualCharacterRange: nil)
            let bounds = layoutManager.boundingRect(forGlyphRange: glyphs, in: textContainer)
            let firstLine = layoutManager.lineFragmentRect(forGlyphAt: glyphs.location, effectiveRange: nil)
            let frame = CGRect(
                x: textContainerInset.left + views.card.indent,
                y: textContainerInset.top + firstLine.minY,
                width: max(1, self.bounds.width - textContainerInset.left - textContainerInset.right - views.card.indent),
                height: max(MarkdownCodeCard.headerHeight, bounds.maxY - firstLine.minY)
            )
            views.background.frame = frame
            views.header.frame = CGRect(origin: frame.origin, size: CGSize(width: frame.width, height: MarkdownCodeCard.headerHeight))
            bringSubviewToFront(views.header)
        }
    }

    private func updateCardColors() {
        for views in cards {
            views.background.backgroundColor = T3Colors.uiSurfaceRaised
            views.background.layer.borderColor = UIColor(T3Colors.textTertiary).withAlphaComponent(0.2).resolvedColor(with: traitCollection).cgColor
        }
    }
}

private final class MarkdownCodeHeaderView: UIView {
    private let label = UILabel()
    private let copyButton = UIButton(type: .system)
    private let divider = UIView()

    init(card: MarkdownCodeCard) {
        super.init(frame: .zero)
        label.text = card.language.flatMap { $0.isEmpty ? nil : $0.uppercased() } ?? "CODE"
        label.font = .preferredFont(forTextStyle: .caption1)
        label.adjustsFontForContentSizeCategory = true
        label.textColor = UIColor(T3Colors.textTertiary)
        var configuration = UIButton.Configuration.plain()
        configuration.title = "Copy"
        configuration.image = UIImage(systemName: "doc.on.doc")
        configuration.imagePadding = 4
        configuration.baseForegroundColor = T3Colors.uiTextSecondary
        copyButton.configuration = configuration
        copyButton.accessibilityLabel = "Copy code block"
        copyButton.accessibilityHint = "Copies this code block"
        copyButton.addAction(UIAction { _ in UIPasteboard.general.string = card.code }, for: .touchUpInside)
        divider.backgroundColor = UIColor(T3Colors.textTertiary).withAlphaComponent(0.2)
        addSubview(label)
        addSubview(copyButton)
        addSubview(divider)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layoutSubviews() {
        super.layoutSubviews()
        let buttonWidth = max(70, copyButton.sizeThatFits(bounds.size).width)
        copyButton.frame = CGRect(x: bounds.width - buttonWidth - 5, y: 0, width: buttonWidth, height: bounds.height)
        label.frame = CGRect(x: 13, y: 0, width: max(0, copyButton.frame.minX - 21), height: bounds.height)
        divider.frame = CGRect(x: 0, y: bounds.height - 1, width: bounds.width, height: 1)
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let buttonPoint = convert(point, to: copyButton)
        return copyButton.point(inside: buttonPoint, with: event) ? copyButton.hitTest(buttonPoint, with: event) : nil
    }
}
