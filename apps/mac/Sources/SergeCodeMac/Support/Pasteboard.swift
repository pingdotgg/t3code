import AppKit
import UniformTypeIdentifiers

/// Thin wrapper over the general pasteboard so message/code copy actions
/// share one implementation. Also exposes image-paste helpers for the
/// composer (Cmd+V of screenshots / Finder image files).
@MainActor
enum Pasteboard {
    static func copy(_ string: String) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(string, forType: .string)
    }

    /// Reads image payloads currently on the general pasteboard.
    /// Prefer this over `.onPasteCommand` when a `TextEditor` is first
    /// responder — AppKit's NSTextView consumes Cmd+V before SwiftUI paste
    /// commands fire for image-only clipboards.
    static func imagePayloads() -> [(name: String, mimeType: String, data: Data)] {
        let pasteboard = NSPasteboard.general
        var payloads: [(name: String, mimeType: String, data: Data)] = []
        var seen = Set<Data>()

        // Finder file copies: file URLs that point at images.
        if let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [
            .urlReadingFileURLsOnly: true,
        ]) as? [URL] {
            for url in urls {
                guard isImageFile(url), let data = try? Data(contentsOf: url), !data.isEmpty else {
                    continue
                }
                guard seen.insert(data).inserted else { continue }
                let mime =
                    UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
                    ?? "image/png"
                guard mime.hasPrefix("image/") else { continue }
                payloads.append((name: url.lastPathComponent, mimeType: mime, data: data))
            }
        }

        // Raw image types (screenshots, Preview copy, browser copy-as-image).
        let imageTypes: [(NSPasteboard.PasteboardType, String, String)] = [
            (NSPasteboard.PasteboardType("public.png"), "image/png", "png"),
            (.png, "image/png", "png"),
            (.tiff, "image/tiff", "tiff"),
            (NSPasteboard.PasteboardType("public.jpeg"), "image/jpeg", "jpg"),
            (NSPasteboard.PasteboardType("public.tiff"), "image/tiff", "tiff"),
        ]
        for (type, mime, ext) in imageTypes {
            guard let data = pasteboard.data(forType: type), !data.isEmpty else { continue }
            // Normalize TIFF (common screenshot type) to PNG for smaller uploads.
            let encoded: (mime: String, ext: String, data: Data)
            if mime == "image/tiff",
                let image = NSImage(data: data),
                let tiff = image.tiffRepresentation,
                let rep = NSBitmapImageRep(data: tiff),
                let png = rep.representation(using: .png, properties: [:])
            {
                encoded = ("image/png", "png", png)
            } else {
                encoded = (mime, ext, data)
            }
            guard seen.insert(encoded.data).inserted else { continue }
            let index = payloads.count + 1
            payloads.append(
                (name: "Pasted image \(index).\(encoded.ext)", mimeType: encoded.mime,
                    data: encoded.data))
        }

        // Last resort: NSImage can assemble multi-representation pasteboards.
        if payloads.isEmpty, let image = NSImage(pasteboard: pasteboard),
            let tiff = image.tiffRepresentation,
            let rep = NSBitmapImageRep(data: tiff),
            let png = rep.representation(using: .png, properties: [:]),
            seen.insert(png).inserted
        {
            payloads.append((name: "Pasted image 1.png", mimeType: "image/png", data: png))
        }

        return payloads
    }

    /// True when the pasteboard has image content we should claim for attach
    /// (image-only or image+text screenshots) rather than text paste.
    static var hasImagePayload: Bool {
        !imagePayloads().isEmpty
    }

    private static func isImageFile(_ url: URL) -> Bool {
        if let type = UTType(filenameExtension: url.pathExtension), type.conforms(to: .image) {
            return true
        }
        return false
    }
}
