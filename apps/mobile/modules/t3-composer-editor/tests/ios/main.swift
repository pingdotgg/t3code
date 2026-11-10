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
  exit(0)
}
dispatchMain()
