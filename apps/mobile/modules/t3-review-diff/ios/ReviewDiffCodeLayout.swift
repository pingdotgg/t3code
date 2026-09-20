import UIKit

/// ASCII uses fixed-pitch columns. TextKit handles shaping, tabs, and Unicode highlights.
final class ReviewDiffCodeLayout: NSObject {
  // Measurement reuses one engine; only recently drawn rows retain a full TextKit layout.
  private static var measurer: ReviewDiffTextLayout {
    let key = "T3ReviewDiff.textMeasurer"
    if let layout = Thread.current.threadDictionary[key] as? ReviewDiffTextLayout { return layout }
    let layout = ReviewDiffTextLayout()
    Thread.current.threadDictionary[key] = layout
    return layout
  }
  private static let drawnLayouts: NSCache<ReviewDiffCodeLayout, ReviewDiffTextLayout> = {
    let cache = NSCache<ReviewDiffCodeLayout, ReviewDiffTextLayout>()
    cache.countLimit = 128
    return cache
  }()
  let text: String
  let starts: [Int]
  let lineHeight: CGFloat
  let firstLineHeight: CGFloat
  let extraHeight: CGFloat
  private let font: UIFont
  private let width: CGFloat
  private let characterWidth: CGFloat
  let usesNativeLayout: Bool

  init(text: String, font: UIFont, width: CGFloat, characterWidth: CGFloat) {
    self.text = text
    self.font = font
    self.width = width
    self.characterWidth = characterWidth
    lineHeight = ceil(font.lineHeight)
    if text.utf8.allSatisfy({ $0 >= 32 && $0 <= 126 }) {
      let columns = max(1, Int(width / characterWidth))
      starts = Array(stride(from: 0, to: max(1, text.utf8.count), by: columns))
      firstLineHeight = font.lineHeight
      extraHeight = CGFloat(starts.count - 1) * lineHeight
      usesNativeLayout = false
    } else {
      let layout = Self.measurer
      layout.configure(text: text, font: font, width: width, characterWidth: characterWidth)
      let manager = layout.manager
      let container = layout.container
      usesNativeLayout = true
      starts = [0]
      firstLineHeight = manager.numberOfGlyphs > 0
        ? manager.lineFragmentRect(forGlyphAt: 0, effectiveRange: nil).height : font.lineHeight
      extraHeight = max(0, manager.usedRect(for: container).height - firstLineHeight)
    }
  }

  private func nativeLayout() -> ReviewDiffTextLayout {
    if let cached = Self.drawnLayouts.object(forKey: self) { return cached }
    let layout = ReviewDiffTextLayout()
    layout.configure(text: text, font: font, width: width, characterWidth: characterWidth)
    Self.drawnLayouts.setObject(layout, forKey: self)
    return layout
  }

  /// Only colors change when syntax tokens arrive; the measured text and font stay intact.
  func decorate(text: NSAttributedString, highlights: [NSRange], color: UIColor, version: Int) {
    guard usesNativeLayout else { return }
    let layout = nativeLayout()
    guard layout.decorationVersion != version else { return }
    let storage = layout.storage
    let fullRange = NSRange(location: 0, length: storage.length)
    storage.beginEditing()
    storage.removeAttribute(.foregroundColor, range: fullRange)
    storage.removeAttribute(.backgroundColor, range: fullRange)
    text.enumerateAttribute(.foregroundColor, in: NSRange(location: 0, length: text.length)) { value, range, _ in
      let intersection = NSIntersectionRange(range, fullRange)
      if let value, intersection.length > 0 {
        storage.addAttribute(.foregroundColor, value: value, range: intersection)
      }
    }
    for range in highlights {
      let intersection = NSIntersectionRange(range, fullRange)
      if intersection.length > 0 {
        storage.addAttribute(.backgroundColor, value: color, range: intersection)
      }
    }
    storage.endEditing()
    layout.decorationVersion = version
  }

  func draw(at origin: CGPoint, clip: CGRect) {
    guard usesNativeLayout else { return }
    let layout = nativeLayout()
    let manager = layout.manager
    let container = layout.container
    let visible = clip.offsetBy(dx: -origin.x, dy: -origin.y)
    let range = manager.glyphRange(forBoundingRect: visible, in: container)
    manager.drawBackground(forGlyphRange: range, at: origin)
    manager.drawGlyphs(forGlyphRange: range, at: origin)
  }
}

private final class ReviewDiffTextLayout {
  let storage = NSTextStorage()
  let manager = NSLayoutManager()
  let container = NSTextContainer(size: .zero)
  var decorationVersion = -1

  init() {
    container.lineFragmentPadding = 0
    container.lineBreakMode = .byCharWrapping
    manager.addTextContainer(container)
    storage.addLayoutManager(manager)
  }

  func configure(text: String, font: UIFont, width: CGFloat, characterWidth: CGFloat) {
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineBreakMode = .byCharWrapping
    paragraph.tabStops = []
    paragraph.defaultTabInterval = characterWidth * 4
    container.size = CGSize(width: max(1, width), height: .greatestFiniteMagnitude)
    storage.setAttributedString(NSAttributedString(string: text, attributes: [
      .font: font, .ligature: 0, .paragraphStyle: paragraph,
    ]))
    manager.ensureLayout(for: container)
  }
}
