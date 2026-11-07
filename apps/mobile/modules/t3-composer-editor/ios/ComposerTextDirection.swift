import Foundation

// Keep the word vote and Unicode ranges in sync with apps/web/src/textDirection.ts.
enum ComposerTextDirection {
  struct Paragraph {
    let range: NSRange
    let isRTL: Bool
    let codeRanges: [NSRange]
  }

  private static let inlineCode = try? NSRegularExpression(
    pattern: #"(?<!`)(`+)(?!`)[^\r\n]*?(?<!`)\1(?!`)"#
  )
  private static let fence = try? NSRegularExpression(pattern: #"^ {0,3}(`{3,}|~{3,})(.*)$"#)

  static func paragraphs(in text: String) -> [Paragraph] {
    let source = text as NSString
    var paragraphs: [Paragraph] = []
    var previous = false
    var openFence: (marker: unichar, count: Int)?
    var cursor = 0
    while true {
      var start = cursor
      var end = cursor
      var contentsEnd = cursor
      if cursor < source.length {
        source.getParagraphStart(&start, end: &end, contentsEnd: &contentsEnd,
                                 for: NSRange(location: cursor, length: 0))
      }
      let range = NSRange(location: cursor, length: end - cursor)
      let line = source.substring(with: NSRange(location: cursor, length: contentsEnd - cursor)) as NSString
      let match = fence?.firstMatch(in: line as String, range: NSRange(location: 0, length: line.length))
      var isCode = openFence != nil
      if let match {
        let delimiter = line.substring(with: match.range(at: 1)) as NSString
        let tail = line.substring(with: match.range(at: 2))
        if let current = openFence {
          if delimiter.character(at: 0) == current.marker && delimiter.length >= current.count &&
             tail.trimmingCharacters(in: .whitespaces).isEmpty {
            openFence = nil
          }
        } else if delimiter.character(at: 0) != 0x60 || !tail.contains("`") {
          openFence = (delimiter.character(at: 0), delimiter.length)
          isCode = true
        }
      }
      let codeRanges = isCode ? [NSRange(location: 0, length: line.length)] :
        (inlineCode?.matches(in: line as String, range: NSRange(location: 0, length: line.length)) ?? []).map(\.range)
      let prose = NSMutableString(string: line as String)
      for code in codeRanges.reversed() {
        prose.replaceCharacters(in: code, with: String(repeating: " ", count: code.length))
      }
      let isRTL = isCode ? false : wordDirection(prose as String) ?? previous
      if !isCode { previous = isRTL }
      paragraphs.append(Paragraph(
        range: range,
        isRTL: isRTL,
        codeRanges: codeRanges.map { NSRange(location: cursor + $0.location, length: $0.length) }
      ))
      if end == source.length && (contentsEnd == end || range.length == 0) { break }
      cursor = end
    }
    return paragraphs
  }

  static func wordDirection(_ text: String) -> Bool? {
    var rtl = 0
    var ltr = 0
    var first: Bool?
    var hasLetter = false
    for scalar in text.unicodeScalars {
      let value = scalar.value
      // ECMAScript \s, plus the display-only chip placeholder as a word boundary.
      switch value {
      case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029,
           0x202F, 0x205F, 0x3000, 0xFEFF, 0xFFFC:
        hasLetter = false
        continue
      default:
        break
      }
      guard !hasLetter else { continue }
      switch scalar.properties.generalCategory {
      case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter:
        let isRTL = (0x0590...0x08FF).contains(value) || (0xFB1D...0xFDFF).contains(value) ||
          (0xFE70...0xFEFF).contains(value) || (0x10800...0x10FFF).contains(value) ||
          (0x1E800...0x1EFFF).contains(value)
        if first == nil { first = isRTL }
        if isRTL { rtl += 1 } else { ltr += 1 }
        hasLetter = true
      default:
        continue
      }
    }
    return rtl == ltr ? first : rtl > ltr
  }
}
