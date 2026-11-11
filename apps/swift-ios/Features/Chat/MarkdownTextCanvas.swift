import SwiftUI
import UIKit

extension EnvironmentValues {
    /// True for the one message the reader chose to select text in ("Select
    /// Text" in its menu). Every other message draws text without a text view.
    @Entry var markdownTextSelectable = false
}

/// Draws one block of Markdown text without a text view.
///
/// A `UITextView` per paragraph was about 60% of every transcript scroll
/// hitch: creating it, its TextKit 2 layout, and its teardown. This view
/// measures and draws the attributed string directly, and builds a TextKit 1
/// stack only to find a tapped link. Skill pills are image attachments, so
/// they draw the same way.
final class MarkdownTextCanvas: UIView, UIGestureRecognizerDelegate {
    private static let options: NSStringDrawingOptions = [.usesLineFragmentOrigin, .usesFontLeading]

    var attributedText = NSAttributedString() {
        didSet {
            guard attributedText !== oldValue else { return }
            sizes.removeAll(keepingCapacity: true)
            linkTap.isEnabled = attributedText.containsAttribute(.link)
            accessibilityLabel = attributedText.string
            setNeedsDisplay()
        }
    }

    var onOpenURL: ((URL) -> Void)?
    private var sizes: [CGFloat: CGSize] = [:]
    private lazy var linkTap = UITapGestureRecognizer(target: self, action: #selector(openTappedLink))

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        backgroundColor = .clear
        contentMode = .redraw
        isAccessibilityElement = true
        accessibilityTraits = .staticText
        linkTap.delegate = self
        linkTap.isEnabled = false
        addGestureRecognizer(linkTap)
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: Self, _) in
            view.setNeedsDisplay()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    /// Hugs its text up to `width`; `nil` lays the text out on unbroken lines.
    func size(fitting width: CGFloat?) -> CGSize {
        let key = width ?? .infinity
        if let cached = sizes[key] { return cached }
        let bounds = attributedText.boundingRect(
            with: CGSize(width: width ?? .greatestFiniteMagnitude, height: .greatestFiniteMagnitude),
            options: Self.options,
            context: nil
        )
        let fitted = CGSize(
            width: max(1, min(width ?? .greatestFiniteMagnitude, ceil(bounds.width))),
            height: max(1, ceil(bounds.height))
        )
        sizes[key] = fitted
        return fitted
    }

    override func draw(_ rect: CGRect) {
        attributedText.draw(with: bounds, options: Self.options, context: nil)
    }

    override func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
        guard gesture === linkTap else { return super.gestureRecognizerShouldBegin(gesture) }
        return link(at: gesture.location(in: self)) != nil
    }

    @objc private func openTappedLink(_ gesture: UITapGestureRecognizer) {
        guard let url = link(at: gesture.location(in: self)) else { return }
        onOpenURL?(url)
    }

    private func link(at point: CGPoint) -> URL? {
        let storage = NSTextStorage(attributedString: attributedText)
        let layout = NSLayoutManager()
        let container = NSTextContainer(size: CGSize(width: bounds.width, height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        layout.addTextContainer(container)
        storage.addLayoutManager(layout)
        guard layout.numberOfGlyphs > 0 else { return nil }
        let glyph = layout.glyphIndex(for: point, in: container)
        let glyphRect = layout.boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: container)
        guard glyphRect.insetBy(dx: -6, dy: -6).contains(point) else { return nil }
        let value = attributedText.attribute(.link, at: layout.characterIndexForGlyph(at: glyph), effectiveRange: nil)
        return value as? URL ?? (value as? String).flatMap(URL.init(string:))
    }
}

private extension NSAttributedString {
    func containsAttribute(_ key: Key) -> Bool {
        var found = false
        enumerateAttribute(key, in: NSRange(location: 0, length: length)) { value, _, stop in
            if value != nil {
                found = true
                stop.pointee = true
            }
        }
        return found
    }
}
