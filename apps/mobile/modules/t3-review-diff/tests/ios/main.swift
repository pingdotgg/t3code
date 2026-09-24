import UIKit

func check(_ passed: Bool, _ message: String = "Failed layout check") {
  if !passed {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
  }
}

// Runs the production layout against UIKit through Mac Catalyst, without launching an app.
let font = UIFont.monospacedSystemFont(ofSize: 14, weight: .regular)
let characterWidth = ("M" as NSString).size(withAttributes: [.font: font]).width
let fixtures = ["漢字表示", "e\u{301}", "👨‍👩‍👧‍👦", "مرحبا بالعالم ", "\tvalue "]
var cases = 0
for fixture in fixtures {
  let text = String(repeating: fixture, count: 40)
  var previousHeight = CGFloat.greatestFiniteMagnitude
  for width: CGFloat in [180, 280, 420] {
    let layout = ReviewDiffCodeLayout(text: text, font: font, width: width, characterWidth: characterWidth)
    let height = layout.firstLineHeight + layout.extraHeight
    check(height <= previousHeight, "Wider text must not require more height")
    previousHeight = height
    let fullRange = NSRange(location: 0, length: text.utf16.count)
    let attributed = NSAttributedString(string: text, attributes: [.foregroundColor: UIColor.black])
    layout.decorate(text: attributed, highlights: [], color: .clear, version: 0)
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    format.opaque = false
    format.preferredRange = .standard
    let size = CGSize(width: width + 40, height: ceil(height))
    let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
      layout.draw(at: .zero, clip: CGRect(origin: .zero, size: size))
    }
    let bitmap = image.cgImage!
    let data = bitmap.dataProvider!.data!
    let bytes = CFDataGetBytePtr(data)!
    // Render without a viewport clip so an overflowing glyph cannot hide behind clipping.
    for y in 0..<bitmap.height {
      for x in Int(width) + 1..<bitmap.width {
        check(bytes[y * bitmap.bytesPerRow + x * 4 + 3] == 0, "Ink outside viewport: \(fixture) x=\(x) y=\(y) bpp=\(bitmap.bitsPerPixel) alpha=\(bitmap.alphaInfo.rawValue)")
      }
    }
    // Updating highlights and syntax colors must preserve measured geometry.
    layout.decorate(text: attributed, highlights: [fullRange], color: .green, version: 1)
    check(layout.firstLineHeight + layout.extraHeight == height)
    cases += 1
  }
}
let ascii = String(repeating: "const value = 123; ", count: 100)
let layout = ReviewDiffCodeLayout(text: ascii, font: font, width: 280, characterWidth: characterWidth)
let string = ascii as NSString
var reconstructed = ""
for (index, start) in layout.starts.enumerated() {
  let end = index + 1 < layout.starts.count ? layout.starts[index + 1] : string.length
  let segment = string.substring(with: NSRange(location: start, length: end - start))
  check((segment as NSString).size(withAttributes: [.font: font]).width <= 280)
  reconstructed += segment
}
check(reconstructed == ascii)
print("Passed \(cases) Unicode/width cases, color-update geometry, and ASCII coverage")
