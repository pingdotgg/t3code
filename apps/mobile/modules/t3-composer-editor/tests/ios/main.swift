import UniformTypeIdentifiers
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
  func chip(at location: Int) -> NSTextAttachment? {
    textView.textStorage.attribute(.attachment, at: location, effectiveRange: nil) as? NSTextAttachment
  }
}

func document(_ value: String, revision: Int, resetGeneration: Int = 0, isNativeEcho: Bool = false, tokensJson: String = "[]") -> String {
  let payload: [String: Any] = [
    "value": value,
    "selection": NSNull(),
    "tokensJson": tokensJson,
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

func mention(_ label: String, at start: Int, source: String = "@README.md") -> String {
  #"[{"type":"mention","source":"\#(source)","label":"\#(label)","start":\#(start),"end":\#(start + source.utf16.count)}]"#
}

func makeEditor(_ value: String, tokensJson: String = "[]") -> T3ComposerEditorView {
  let view = T3ComposerEditorView()
  view.frame = CGRect(x: 0, y: 0, width: 320, height: 200)
  view.setControlledDocumentJson(document(value, revision: 0, tokensJson: tokensJson))
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

// An echo that only shifts a chip keeps the rendered text; moving or relabeling the chip redraws it.
do {
  let draft = "hi! @README.md @README.md"
  let view = makeEditor("hi @README.md @README.md", tokensJson: mention("README.md", at: 3))
  let rendered = view.chip(at: 3)
  check(rendered != nil, "Harness could not render the chip")
  view.editor.selectedRange = NSRange(location: 2, length: 0)
  view.editor.insertText("!")
  let revision = view.onComposerChange.payloads.last?["eventCount"] as? Int ?? 0
  view.setControlledDocumentJson(document(draft, revision: revision, isNativeEcho: true, tokensJson: mention("README.md", at: 4)))
  check(view.chip(at: 4) === rendered, "An echo that only moved a chip replaced the text")
  view.setControlledDocumentJson(document(draft, revision: revision, tokensJson: mention("Readme", at: 4)))
  check((view.chip(at: 4) as? ComposerTextAttachment)?.label == "Readme", "A relabeled chip was not redrawn")
  view.setControlledDocumentJson(document(draft, revision: revision, tokensJson: mention("Readme", at: 15)))
  check(view.chip(at: 4) == nil && view.chip(at: 15) != nil, "A chip moved to another copy of its source stayed on the old one")
}

// A chip source that changes only in Unicode normalization is rebuilt from the new text.
do {
  let view = makeEditor("@\u{00E9}", tokensJson: mention("e", at: 0, source: "@\u{00E9}"))
  view.setControlledDocumentJson(document("@e\u{0301}", revision: 0, tokensJson: mention("e", at: 0, source: "@e\u{0301}")))
  check(view.text.utf16.elementsEqual("@e\u{0301}".utf16), "A renormalized chip source kept the old text")
}

// The placeholder label is hidden from VoiceOver, so the text view must carry it.
do {
  let view = makeEditor("")
  view.setPlaceholder("Ask anything")
  check(view.editor.accessibilityLabel == "Ask anything", "VoiceOver label: \(String(describing: view.editor.accessibilityLabel))")
}

// Cutting a chip is undoable: Undo restores the chip and tells the parent, Redo removes it again.
// The parent echoes each edit with its re-derived chips; those echoes must not rebuild the text.
do {
  let view = makeEditor("hi @README.md ok", tokensJson: mention("README.md", at: 3))
  func echo() {
    let revision = view.onComposerChange.payloads.last?["eventCount"] as? Int ?? 0
    let chips = view.text.contains("@README.md") ? mention("README.md", at: 3) : "[]"
    view.setControlledDocumentJson(document(view.text, revision: revision, isNativeEcho: true, tokensJson: chips))
  }
  view.editor.selectedRange = NSRange(location: 3, length: 2)
  view.editor.cut(nil)
  check(view.text == "hi ok", "Cut left the selection behind: \(view.text)")
  check(view.onComposerChange.payloads.last?["value"] as? String == "hi ok", "Cut did not emit the new value")
  echo()
  view.editor.undoManager?.undo()
  check(view.text == "hi @README.md ok", "Undo did not restore the cut text: \(view.text)")
  let restored = view.chip(at: 3)
  check(restored is ComposerTextAttachment, "Undo did not restore the cut chip")
  check(view.onComposerChange.payloads.last?["value"] as? String == "hi @README.md ok", "Undo did not emit the restored value")
  echo()
  check(view.chip(at: 3) === restored, "The parent's echo of the restored chip rebuilt the text and dropped Redo")
  view.editor.undoManager?.redo()
  check(view.text == "hi ok", "Redo did not cut again: \(view.text)")
}

print("composer editor tests passed")

private let dropEditor = ComposerTextView()
private let image = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).image { context in
  UIColor.red.setFill()
  context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
}
private let imageProvider = NSItemProvider(object: image)
private let pngProvider = NSItemProvider(item: image.pngData()! as NSData, typeIdentifier: UTType.png.identifier)
private let textProvider = NSItemProvider(object: "plain text" as NSString)
private let fileProvider = NSItemProvider(item: Data("file".utf8) as NSData, typeIdentifier: UTType.data.identifier)

check(dropEditor.canPaste([imageProvider]), "An image drag must reach the composer's UITextDropDelegate")
check(dropEditor.canPaste([pngProvider]), "A PNG representation must reach the image drop handler")
check(dropEditor.canPaste([imageProvider, pngProvider]), "A multi-image drag must be accepted")

private let defaultEditor = UITextView()
for providers in [[textProvider], [], [fileProvider], [imageProvider, textProvider], [imageProvider, fileProvider]] {
  check(dropEditor.canPaste(providers) == defaultEditor.canPaste(providers), "Non-image-only sessions must retain UIKit behavior")
}

dropEditor.isReadOnly = true
check(!dropEditor.canPaste([imageProvider]), "A read-only composer must reject image drops")
dropEditor.isReadOnly = false
dropEditor.isEditable = false
check(!dropEditor.canPaste([imageProvider]), "A noneditable composer must reject image drops")
dropEditor.isEditable = true
check(dropEditor.canPaste([imageProvider]), "An unlocked composer must accept image drops again")
print("Composer image-drop eligibility checks passed")

private final class ImmediateImageProvider: NSItemProvider {
  let image: UIImage
  private(set) var loadCount = 0

  init(image: UIImage) {
    self.image = image
    super.init()
    registerObject(image, visibility: .all)
  }

  override func loadObject(
    ofClass aClass: NSItemProviderReading.Type,
    completionHandler: @escaping @Sendable (NSItemProviderReading?, Error?) -> Void
  ) -> Progress {
    loadCount += 1
    completionHandler(image, nil)
    return Progress(totalUnitCount: 1)
  }
}

private let pasteEditor = ComposerTextView()
private let pasteProvider = ImmediateImageProvider(image: image)
private var pastedImages: [[String]] = []
pasteEditor.text = "Keep this draft"
pasteEditor.onPasteImages = { pastedImages.append($0) }
pasteEditor.paste(itemProviders: [pasteProvider])

for readOnly in [true, false] {
  let lockedEditor = ComposerTextView()
  let provider = ImmediateImageProvider(image: image)
  lockedEditor.isReadOnly = readOnly
  lockedEditor.isEditable = readOnly
  lockedEditor.paste(itemProviders: [provider])
  check(provider.loadCount == 0, "Locked inputs must not load pasted image providers")
}

func interceptedPaste(_ items: [String]) -> String? {
  let savedItems = UIPasteboard.general.items
  defer { UIPasteboard.general.items = savedItems }
  let editor = ComposerTextView()
  editor.textPasteThresholdBytes = 32 * 1024
  var intercepted: String?
  editor.onPasteText = { text, _ in intercepted = text }
  UIPasteboard.general.items = items.map { [UTType.utf8PlainText.identifier: $0] }
  editor.paste(nil)
  return intercepted
}
let halfA = String(repeating: "A", count: 20_000)
let halfB = String(repeating: "B", count: 20_000)
check(interceptedPaste([halfA, halfB]) == halfA + halfB, "Text items that together reach the threshold must fold")

// Two-frame animated GIF: a mixed paste keeps the GIF's original bytes and the still image's PNG, in order.
private let gifBytes = Data(base64Encoded: "R0lGODlhAQABAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAAIBAABBAQAIfkEAAoAAAAsAAAAAAEAAQCBAP8AAAAAAAAAAAAACAQAAQQEADs=")!
private let gifProvider = NSItemProvider()
gifProvider.registerDataRepresentation(forTypeIdentifier: UTType.gif.identifier, visibility: .all) { completion in
  completion(gifBytes, nil)
  return nil
}
private let gifEditor = ComposerTextView()
gifEditor.onPasteImages = { urls in
  let files = urls.compactMap(URL.init(string:))
  let contents = files.compactMap { try? Data(contentsOf: $0) }
  files.forEach { try? FileManager.default.removeItem(at: $0) }
  check(files.map(\.pathExtension) == ["gif", "png"], "A mixed paste must keep each image's format, in order: \(urls)")
  check(contents.first == gifBytes, "A pasted animated GIF must keep its original bytes")
  check(contents.count == 2 && contents[1] == image.pngData(), "The still image beside a GIF must still attach as PNG")
  print("Composer GIF-paste checks passed")
  exit(0)
}

// Inline provider completion places the attachment callback before this main-queue check.
DispatchQueue.main.async {
  check(pastedImages.count == 1, "An accepted provider-based paste must emit exactly one attachment batch")
  check(pastedImages[0].count == 1, "One pasted image must produce one attachment")
  guard let url = URL(string: pastedImages[0][0]),
        let data = try? Data(contentsOf: url),
        let decoded = UIImage(data: data) else {
    check(false, "Provider-based paste must create a readable image file")
    return
  }
  try? FileManager.default.removeItem(at: url)
  check(decoded.cgImage?.width == image.cgImage?.width &&
        decoded.cgImage?.height == image.cgImage?.height && data == image.pngData(),
        "The attachment must contain the pasted image's pixels")
  check(pasteEditor.text == "Keep this draft", "Image paste must preserve the draft text")
  print("Composer provider-paste checks passed")
  check(gifProvider.canLoadObject(ofClass: UIImage.self), "A GIF provider must take the image paste path")
  gifEditor.paste(itemProviders: [gifProvider, ImmediateImageProvider(image: image)])
}
dispatchMain()
