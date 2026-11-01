
func check(_ condition: Bool, _ message: String) {
  if !condition {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
  }
}
let editor = T3ComposerEditorView()
editor.frame = CGRect(x: 0, y: 0, width: 350, height: 200)
let text = "React עדכון הקוד בעברית\nEnglish stays left.\n"
let start = ("React עדכון הקוד בעברית\n" as NSString).length
let count = (text as NSString).length
let document: [String: Any] = [
  "value": text, "tokensJson": "[]", "mostRecentEventCount": 0, "isNativeEcho": false,
  "selection": ["start": count, "end": count],
  "paragraphDirections": [
    ["start": 0, "end": start, "direction": "rtl"],
    ["start": start, "end": count, "direction": "ltr"],
    ["start": count, "end": count, "direction": "ltr"]
  ]
]
editor.setControlledDocumentJson(String(data: try JSONSerialization.data(withJSONObject: document), encoding: .utf8)!)
let input = editor.subviews.compactMap { $0 as? UITextView }.first!
check(input.attributedText.string == text, "Source text changed")
check(input.selectedRange == NSRange(location: count, length: 0), "Caret changed")
let rtl = input.textStorage.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as! NSParagraphStyle
let ltr = input.textStorage.attribute(.paragraphStyle, at: start, effectiveRange: nil) as! NSParagraphStyle
check(rtl.alignment == .right && rtl.baseWritingDirection == .rightToLeft, "Hebrew must align and read RTL")
check(ltr.alignment == .left && ltr.baseWritingDirection == .leftToRight, "English must align and read LTR")
editor.layoutSubviews()
input.layoutManager.ensureLayout(for: input.textContainer)
let rtlGlyphs = input.layoutManager.glyphRange(forCharacterRange: NSRange(location: 0, length: start - 1), actualCharacterRange: nil)
let ltrGlyphs = input.layoutManager.glyphRange(forCharacterRange: NSRange(location: start, length: count - start - 1), actualCharacterRange: nil)
let rtlBounds = input.layoutManager.boundingRect(forGlyphRange: rtlGlyphs, in: input.textContainer)
let ltrBounds = input.layoutManager.boundingRect(forGlyphRange: ltrGlyphs, in: input.textContainer)
check(rtlBounds.maxX > 340 && ltrBounds.minX < 1, "Rendered paragraphs must use opposite edges")
let originalStorage = input.textStorage
var echo = document
echo["isNativeEcho"] = true
editor.setControlledDocumentJson(String(data: try JSONSerialization.data(withJSONObject: echo), encoding: .utf8)!)
check(input.textStorage === originalStorage && input.selectedRange.location == count, "Echo must preserve text storage and caret")
let typing = input.typingAttributes[.paragraphStyle] as! NSParagraphStyle
check(typing.baseWritingDirection == .leftToRight, "Trailing empty paragraph must inherit English")
print("Native paragraph alignment, bidi, text and selection: PASS")
