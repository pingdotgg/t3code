import UIKit
import UniformTypeIdentifiers

enum T3ComposerPasteFiles {
  static func typeIdentifier(for provider: NSItemProvider) -> String? {
    if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
      return UTType.fileURL.identifier
    }
    let namedType = provider.suggestedName.flatMap { UTType(filenameExtension: ($0 as NSString).pathExtension) }
    return provider.registeredTypeIdentifiers.first { identifier in
      guard let type = UTType(identifier) else { return false }
      // RTFD and web archives carry copied rich text without conforming to public.text.
      let isInlineContent = type.conforms(to: .text) || type.conforms(to: .flatRTFD) || type.conforms(to: .webArchive)
      return type.conforms(to: .data) && !type.conforms(to: .url) &&
        (!isInlineContent || namedType?.conforms(to: type) == true)
    }
  }

  static func containsFiles(_ providers: [NSItemProvider]) -> Bool {
    providers.contains { provider in
      typeIdentifier(for: provider) != nil && !provider.canLoadObject(ofClass: UIImage.self)
    }
  }

  static func load(_ providers: [NSItemProvider], completion: @escaping ([[String: Any]], Bool) -> Void) {
    let group = DispatchGroup()
    let lock = NSLock()
    var files = [[String: Any]?](repeating: nil, count: providers.count)
    for (index, provider) in providers.enumerated() {
      guard let identifier = typeIdentifier(for: provider) else { continue }
      group.enter()
      let receive: (URL?) -> Void = { url in
        defer { group.leave() }
        guard let url, url.isFileURL else { return }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        do {
          guard try url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else { return }
          let type = UTType(filenameExtension: url.pathExtension) ?? UTType(identifier)
          var name = provider.suggestedName ?? url.lastPathComponent
          if (name as NSString).pathExtension.isEmpty, let ext = type?.preferredFilenameExtension {
            name += ".\(ext)"
          }
          let directory = FileManager.default.temporaryDirectory.appendingPathComponent("t3-composer-paste-files")
          try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
          let destination = directory.appendingPathComponent(UUID().uuidString).appendingPathExtension((name as NSString).pathExtension)
          // Item-provider URLs expire when this callback returns.
          try FileManager.default.copyItem(at: url, to: destination)
          lock.lock()
          files[index] = [
            "uri": destination.absoluteString,
            "name": name,
            "mimeType": type?.preferredMIMEType ?? "application/octet-stream",
          ]
          lock.unlock()
        } catch {
          return
        }
      }
      if identifier == UTType.fileURL.identifier {
        provider.loadObject(ofClass: URL.self) { url, _ in receive(url) }
      } else {
        provider.loadFileRepresentation(forTypeIdentifier: identifier) { url, _ in receive(url) }
      }
    }
    group.notify(queue: .main) {
      let loaded = files.compactMap { $0 }
      completion(loaded, loaded.count != providers.count)
    }
  }
}
