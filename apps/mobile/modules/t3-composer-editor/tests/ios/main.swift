import UniformTypeIdentifiers

private func check(_ passed: Bool, _ message: String) {
  if !passed {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
  }
}

private let editor = ComposerTextView()
private let image = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).image { context in
  UIColor.red.setFill()
  context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
}
private let imageProvider = NSItemProvider(object: image)
private let pngProvider = NSItemProvider(item: image.pngData()! as NSData, typeIdentifier: UTType.png.identifier)
private let textProvider = NSItemProvider(object: "plain text" as NSString)
private let fileProvider = NSItemProvider(item: Data("file".utf8) as NSData, typeIdentifier: UTType.data.identifier)

check(editor.canPaste([imageProvider]), "An image drag must reach the composer's UITextDropDelegate")
check(editor.canPaste([pngProvider]), "A PNG representation must reach the image drop handler")
check(editor.canPaste([imageProvider, pngProvider]), "A multi-image drag must be accepted")

private let defaultEditor = UITextView()
for providers in [[textProvider], [], [fileProvider], [imageProvider, textProvider], [imageProvider, fileProvider]] {
  check(editor.canPaste(providers) == defaultEditor.canPaste(providers), "Non-image-only sessions must retain UIKit behavior")
}

editor.isReadOnly = true
check(!editor.canPaste([imageProvider]), "A read-only composer must reject image drops")
editor.isReadOnly = false
editor.isEditable = false
check(!editor.canPaste([imageProvider]), "A noneditable composer must reject image drops")
editor.isEditable = true
check(editor.canPaste([imageProvider]), "An unlocked composer must accept image drops again")
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
