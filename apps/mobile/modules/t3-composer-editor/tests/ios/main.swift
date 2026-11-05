import UIKit

func check(_ passed: Bool, _ message: String) {
  if !passed {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
  }
}

extension T3ComposerEditorView {
  var editor: UITextView { textView }
  var text: String { textView.serializedText() }
}

func document(_ value: String, revision: Int, resetGeneration: Int = 0, isNativeEcho: Bool = false) -> String {
  let payload: [String: Any] = [
    "value": value,
    "selection": NSNull(),
    "tokensJson": "[]",
    "mostRecentEventCount": revision,
    "isNativeEcho": isNativeEcho,
    "resetGeneration": resetGeneration,
  ]
  return String(data: try! JSONSerialization.data(withJSONObject: payload), encoding: .utf8)!
}

func replace(_ view: T3ComposerEditorView, _ target: String, with replacement: String) {
  let editor = view.editor
  let location = (editor.text as NSString).range(of: target).location
  let start = editor.position(from: editor.beginningOfDocument, offset: location)!
  let end = editor.position(from: start, offset: (target as NSString).length)!
  editor.replace(editor.textRange(from: start, to: end)!, withText: replacement)
}

func makeEditor(_ value: String) -> T3ComposerEditorView {
  let view = T3ComposerEditorView()
  view.frame = CGRect(x: 0, y: 0, width: 320, height: 200)
  view.setControlledDocumentJson(document(value, revision: 0))
  check(view.text == value, "Initial controlled value was not applied")
  return view
}

// A send clears the draft after an autocorrection the parent had not received yet.
do {
  let view = makeEditor("hello wrold")
  replace(view, "wrold", with: "world")
  let corrected = view.onComposerChange.payloads.last
  check(corrected?["value"] as? String == "hello world", "Autocorrection did not emit a change")
  check(corrected?["eventCount"] as? Int == 1, "Autocorrection did not advance the native revision")
  view.setControlledDocumentJson(document("", revision: 0, resetGeneration: 1))
  check(view.text == "", "Send clear lost to an autocorrection the parent had not seen: \(view.text)")
  check(corrected?["resetGeneration"] as? Int == 0, "Pre-clear native event must carry the old reset generation")
  view.editor.insertText("n")
  let typed = view.onComposerChange.payloads.last
  check(typed?["value"] as? String == "n", "Typing after the clear did not start from empty")
  check(typed?["resetGeneration"] as? Int == 1, "Typing after the clear must carry the new reset generation")
  check(typed?["eventCount"] as? Int == 1, "Typing after the clear must follow the parent's revision")
}

// An attachment-only send can reset an empty JS draft before a native keystroke is delivered.
do {
  let view = makeEditor("")
  view.editor.insertText("x")
  view.setControlledDocumentJson(document("", revision: 0, resetGeneration: 1, isNativeEcho: true))
  check(view.text == "", "An echo-marked reset retained an undelivered keystroke: \(view.text)")
  view.editor.insertText("n")
  check(view.text == "n", "Typing after an echo-marked reset restored the previous keystroke")
  view.setControlledDocumentJson(document("", revision: 1, resetGeneration: 1, isNativeEcho: true))
  check(view.text == "n", "An ordinary mismatched echo overwrote newer native typing")
}

// Moving the editor to another draft can lower the parent's reset generation; that payload stays ordinary.
do {
  let view = makeEditor("draft a")
  view.setControlledDocumentJson(document("", revision: 0, resetGeneration: 2))
  view.setControlledDocumentJson(document("draft b", revision: 0, resetGeneration: 1))
  check(view.text == "draft b", "A lower reset generation was rejected")
  view.editor.insertText("!")
  check(
    view.onComposerChange.payloads.last?["resetGeneration"] as? Int == 2,
    "A lower reset generation rewound the editor's"
  )
}

// Without a reset, a payload behind the native revision still loses to newer typing.
do {
  let view = makeEditor("ab")
  view.editor.selectedRange = NSRange(location: 2, length: 0)
  view.editor.insertText("c")
  view.setControlledDocumentJson(document("ab", revision: 0))
  check(view.text == "abc", "A stale controlled value overwrote newer native typing")
}

// A send clear during an IME composition must not come back when the composition commits.
do {
  let view = makeEditor("hello ")
  view.editor.selectedRange = NSRange(location: 6, length: 0)
  view.editor.setMarkedText("wor", selectedRange: NSRange(location: 3, length: 0))
  check(view.editor.markedTextRange != nil, "Harness could not start a composition")
  let revision = view.onComposerChange.payloads.last?["eventCount"] as? Int ?? 0
  view.setControlledDocumentJson(document("", revision: revision, resetGeneration: 1))
  view.editor.unmarkText()
  check(view.text == "", "Send clear lost to a committed composition: \(view.text)")
  check(
    !view.onComposerChange.payloads.contains { ($0["value"] as? String)?.contains("hello") == true && ($0["resetGeneration"] as? Int) == 1 },
    "Committed composition republished the sent draft"
  )
}

// Paragraph directions align and read each paragraph without changing source text or caret.
do {
  let view = T3ComposerEditorView()
  view.frame = CGRect(x: 0, y: 0, width: 350, height: 200)
  let text = "React עדכון הקוד בעברית\nEnglish stays left.\n"
  let start = ("React עדכון הקוד בעברית\n" as NSString).length
  let count = (text as NSString).length
  var payload: [String: Any] = [
    "value": text, "tokensJson": "[]", "mostRecentEventCount": 0, "isNativeEcho": false,
    "resetGeneration": 0, "selection": ["start": count, "end": count],
    "paragraphDirections": [
      ["start": 0, "end": start, "direction": "rtl"],
      ["start": start, "end": count, "direction": "ltr"],
      ["start": count, "end": count, "direction": "ltr"],
    ],
  ]
  view.setControlledDocumentJson(String(data: try! JSONSerialization.data(withJSONObject: payload), encoding: .utf8)!)
  let input = view.editor
  check(input.attributedText.string == text, "Source text changed")
  check(input.selectedRange == NSRange(location: count, length: 0), "Caret changed")
  let rtl = input.textStorage.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as! NSParagraphStyle
  let ltr = input.textStorage.attribute(.paragraphStyle, at: start, effectiveRange: nil) as! NSParagraphStyle
  check(rtl.alignment == .right && rtl.baseWritingDirection == .rightToLeft, "Hebrew must align and read RTL")
  check(ltr.alignment == .left && ltr.baseWritingDirection == .leftToRight, "English must align and read LTR")
  view.layoutSubviews()
  input.layoutManager.ensureLayout(for: input.textContainer)
  let rtlGlyphs = input.layoutManager.glyphRange(forCharacterRange: NSRange(location: 0, length: start - 1), actualCharacterRange: nil)
  let ltrGlyphs = input.layoutManager.glyphRange(forCharacterRange: NSRange(location: start, length: count - start - 1), actualCharacterRange: nil)
  let rtlBounds = input.layoutManager.boundingRect(forGlyphRange: rtlGlyphs, in: input.textContainer)
  let ltrBounds = input.layoutManager.boundingRect(forGlyphRange: ltrGlyphs, in: input.textContainer)
  check(rtlBounds.maxX > 340 && ltrBounds.minX < 1, "Rendered paragraphs must use opposite edges")
  let originalStorage = input.textStorage
  payload["isNativeEcho"] = true
  view.setControlledDocumentJson(String(data: try! JSONSerialization.data(withJSONObject: payload), encoding: .utf8)!)
  check(input.textStorage === originalStorage && input.selectedRange.location == count, "Echo must preserve text storage and caret")
  let typing = input.typingAttributes[.paragraphStyle] as! NSParagraphStyle
  check(typing.baseWritingDirection == .leftToRight, "Trailing empty paragraph must inherit English")
}

print("composer editor tests passed")
