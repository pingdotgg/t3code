import UIKit

/// A message can contain many screens of text. A character stays in place
/// through line wrapping where a pixel offset from the message top cannot.
@MainActor
struct TranscriptTextAnchor {
    private let text: String
    private let textViewIndex: Int
    private let characterOffset: Int
    private let viewportOffset: CGFloat

    static func capture(in cell: UIView, viewport: UIScrollView) -> Self? {
        let top = viewport.bounds.minY + viewport.adjustedContentInset.top
        let bottom = viewport.bounds.maxY - viewport.adjustedContentInset.bottom
        let candidates = textViews(in: cell).enumerated().compactMap { index, view -> (Int, UITextView, CGRect)? in
            let frame = view.convert(view.bounds, to: viewport)
            guard !view.isHidden, view.hasText, frame.maxY > top, frame.minY < bottom else { return nil }
            return (index, view, frame)
        }
        guard let (index, view, frame) = candidates.min(by: { $0.2.minY < $1.2.minY }),
              let position = view.closestPosition(to: view.convert(
                CGPoint(x: frame.minX + view.textContainerInset.left, y: max(top, frame.minY)), from: viewport
              )) else { return nil }
        let caret = view.convert(view.caretRect(for: position), to: viewport)
        return Self(text: view.text, textViewIndex: index,
                    characterOffset: view.offset(from: view.beginningOfDocument, to: position),
                    viewportOffset: caret.minY - viewport.contentOffset.y)
    }

    func targetOffset(in cell: UIView, viewport: UIScrollView) -> CGFloat? {
        let views = Self.textViews(in: cell)
        let view = views.indices.contains(textViewIndex) && views[textViewIndex].text == text
            ? views[textViewIndex] : views.first(where: { $0.text == text })
        guard let view,
              let position = view.position(from: view.beginningOfDocument, offset: characterOffset) else { return nil }
        return view.convert(view.caretRect(for: position), to: viewport).minY - viewportOffset
    }

    private static func textViews(in view: UIView) -> [UITextView] {
        if let textView = view as? UITextView { return [textView] }
        return view.subviews.flatMap { textViews(in: $0) }
    }
}
