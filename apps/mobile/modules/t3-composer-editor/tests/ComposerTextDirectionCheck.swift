import Foundation

let cases: [(String, Bool?)] = [
  ("اكتب دالة تجمع الأرقام", true),
  ("תקן את הבאג", true),
  ("fix the failing test", false),
  ("StrictMode: يعيد الـ render مرتين في التطوير", true),
  ("API: תקן את הבאג", true),
  ("translate the label مرحبا for the login screen", false),
  ("React مكتبة", false),
  ("مكتبة React", true),
  ("عدّل السطر 42، ثم شغّل الاختبارات (3)", true),
  ("42 — 7 ✓", nil),
  ("🇯🇴 𞤀𞤁 𐤀 React", true),
  ("中文 日本語 عربي", false),
  ("abcالعربية مرحبا", false),
  ("hello\u{FEFF}مرحبا\u{FEFF}بالعالم", true),
  ("hello\u{85}مرحبا بالعالم", false),
]
for (text, expected) in cases {
  precondition(ComposerTextDirection.wordDirection(text) == expected, text)
}
let paragraphs: [(String, [Bool])] = [
  ("", [false]),
  ("API: أصلح هذا الخلل\nfix this bug", [true, false]),
  ("عربي\n42\n\n", [true, true, true, true]),
  ("عربي\r\n42\r\n", [true, true, true]),
  ("عربي\n```ts\nمرحبا بالعالم\n```\n42\n", [true, false, false, false, true, true]),
  ("~~~\nعربي عربي\n~~~", [false, false, false]),
  ("````\n```\nعربي عربي\n````", [false, false, false, false]),
  ("عربي `one two three` عربي", [true]),
  ("hello `عربي عربي عربي` world", [false]),
  ("hello `unclosed عربي عربي", [false]),
  ("عربي ``one ` two`` عربي", [true]),
  ("hello\u{FFFC}عربي عربي", [true]),
]
for (text, expected) in paragraphs {
  let result = ComposerTextDirection.paragraphs(in: text)
  precondition(result.map(\.isRTL) == expected, "\(text): \(result.map(\.isRTL))")
  let source = text as NSString
  precondition(result.reduce(0) { $0 + $1.range.length } == source.length)
  for paragraph in result {
    precondition(NSMaxRange(paragraph.range) <= source.length)
    for code in paragraph.codeRanges { precondition(NSMaxRange(code) <= source.length) }
  }
}
let emoji = "🙂 عربي `one two` عربي\n"
let result = ComposerTextDirection.paragraphs(in: emoji)
precondition(result[0].codeRanges == [NSRange(location: 8, length: 9)])
precondition(result.last!.range.location == (emoji as NSString).length)
print("Swift: \(cases.count) word votes, \(paragraphs.count) documents, UTF-16 code and trailing-line ranges passed")
