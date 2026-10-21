import UIKit

/// Draws a project's monogram or emoji tile as a PNG data URI. Native menus take
/// images rather than views, so the iOS thread filter hands them this instead of
/// the React tile ProjectFavicon draws elsewhere. The tint colors the text and,
/// at `backgroundAlpha`, the rounded background.
enum T3ProjectIconImage {
  static func render(
    text: String,
    fontSize: Double,
    size: Double,
    tint: UIColor?,
    backgroundAlpha: Double
  ) -> String? {
    let bounds = CGRect(x: 0, y: 0, width: size, height: size)
    let attributes: [NSAttributedString.Key: Any] = [
      .font: UIFont.monospacedSystemFont(ofSize: fontSize, weight: .bold),
      .foregroundColor: tint ?? UIColor.label,
    ]
    let image = UIGraphicsImageRenderer(size: bounds.size).image { _ in
      if let tint, backgroundAlpha > 0 {
        tint.withAlphaComponent(backgroundAlpha).setFill()
        UIBezierPath(roundedRect: bounds, cornerRadius: size * 0.25).fill()
      }
      let string = text as NSString
      let textSize = string.size(withAttributes: attributes)
      string.draw(
        at: CGPoint(x: (size - textSize.width) / 2, y: (size - textSize.height) / 2),
        withAttributes: attributes
      )
    }
    return image.pngData().map { "data:image/png;base64,\($0.base64EncodedString())" }
  }
}
