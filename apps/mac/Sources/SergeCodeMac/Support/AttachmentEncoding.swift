import Foundation
import UniformTypeIdentifiers

/// Turns local files (paperclip picker, drag-and-drop) and in-memory image
/// bytes (paste/drop) into durable draft `OutgoingAttachment`s. Validation
/// lives here — not in the composer view — so every attachment entry point
/// shares one code path and one set of rules.
///
/// Supported attachments are images (the wire model is image-only); anything
/// else is rejected with a specific, human-readable explanation. Encoded
/// attachments carry their bytes inline as a base64 data URL, so no further
/// filesystem access is needed once encoding succeeds — draft persistence and
/// send/upload never touch the original file again.
enum AttachmentFileEncoder {
    /// Off-main-actor file read + validate + base64 encode. `nonisolated` so
    /// awaiting it from a view hops off the main actor; only `Sendable`
    /// state (URLs, the already-staged attachments, the two caps) crosses in.
    ///
    /// Each URL is checked, in input order (deterministic attachment
    /// ordering), for: attachment cap, existence, folder/package drops,
    /// duplicate input (same file dropped twice in one batch), readability
    /// (including security-scoped access failure), size, image type, and
    /// duplication against already-staged attachments. Failures skip that
    /// file and record an explanation; the last explanation wins, matching
    /// the single-line error surface in the composer.
    nonisolated static func encodeFromFiles(
        urls: [URL],
        existing: [OutgoingAttachment],
        maxAttachments: Int,
        maxAttachmentBytes: Int
    ) async -> (attachments: [OutgoingAttachment], error: String?) {
        var staged: [OutgoingAttachment] = []
        var error: String?
        var count = existing.count
        var seenPaths = Set<String>()
        var fingerprints = Set(existing.map { fingerprint(name: $0.name, sizeBytes: $0.sizeBytes) })
        for url in urls {
            guard count < maxAttachments else {
                error = "At most \(maxAttachments) attachments per message."
                break
            }
            let name = url.lastPathComponent
            let path = url.standardizedFileURL.path
            guard seenPaths.insert(path).inserted else {
                error = "\(name) was dropped more than once."
                continue
            }
            guard
                let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isPackageKey])
            else {
                error = "Could not find \(name)."
                continue
            }
            if values.isPackage == true {
                error = "\(name) is a package and can't be attached."
                continue
            }
            if values.isDirectory == true {
                error = "\(name) is a folder — attach the files inside it instead."
                continue
            }
            // Dropped/picked URLs may point outside the sandbox; retain
            // security-scoped access just for the read. The bytes are kept
            // in the draft from here on, so no longer-lived access is needed.
            let scoped = url.startAccessingSecurityScopedResource()
            let data = try? Data(contentsOf: url)
            if scoped { url.stopAccessingSecurityScopedResource() }
            guard let data else {
                error =
                    FileManager.default.isReadableFile(atPath: path)
                    ? "Could not read \(name)."
                    : "macOS denied access to \(name)."
                continue
            }
            guard data.count <= maxAttachmentBytes else {
                error =
                    "\(name) is over the \(describeLimit(maxAttachmentBytes)) attachment limit."
                continue
            }
            guard let mimeType = imageMIMEType(url: url, data: data) else {
                error = "\(name) is not an image."
                continue
            }
            guard fingerprints.insert(fingerprint(name: name, sizeBytes: data.count)).inserted
            else {
                error = "\(name) is already attached."
                continue
            }
            staged.append(
                OutgoingAttachment(
                    id: UUID().uuidString, name: name, mimeType: mimeType,
                    sizeBytes: data.count,
                    dataURL: "data:\(mimeType);base64,\(data.base64EncodedString())"))
            count += 1
        }
        return (staged, error)
    }

    /// Off-main-actor encode for already-in-memory image bytes (paste/drop),
    /// reusing the same size/count caps as file attachments.
    nonisolated static func encodeFromData(
        _ items: [(name: String, mimeType: String, data: Data)],
        existingCount: Int,
        maxAttachments: Int,
        maxAttachmentBytes: Int
    ) async -> (attachments: [OutgoingAttachment], error: String?) {
        var staged: [OutgoingAttachment] = []
        var error: String?
        var count = existingCount
        for item in items {
            guard count < maxAttachments else {
                error = "At most \(maxAttachments) attachments per message."
                break
            }
            guard item.data.count <= maxAttachmentBytes else {
                error =
                    "\(item.name) is over the \(describeLimit(maxAttachmentBytes)) attachment limit."
                continue
            }
            staged.append(
                OutgoingAttachment(
                    id: UUID().uuidString, name: item.name, mimeType: item.mimeType,
                    sizeBytes: item.data.count,
                    dataURL: "data:\(item.mimeType);base64,\(item.data.base64EncodedString())"))
            count += 1
        }
        return (staged, error)
    }

    /// Heuristic duplicate fingerprint: same display name and byte size is
    /// treated as the same file. Attachments don't retain their source path,
    /// so this is the stable identity available across picker/drop/paste.
    private nonisolated static func fingerprint(name: String, sizeBytes: Int) -> String {
        "\(name)#\(sizeBytes)"
    }

    /// MIME type when the file is an attachable image, `nil` otherwise.
    /// Extension first; for extensionless/unknown files, sniff common image
    /// magic bytes so a raw screenshot saved without an extension can still
    /// attach while random binaries are rejected as "not an image".
    private nonisolated static func imageMIMEType(url: URL, data: Data) -> String? {
        if let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType {
            return mime.hasPrefix("image/") ? mime : nil
        }
        return sniffsAsImage(data) ? "image/png" : nil
    }

    private nonisolated static func sniffsAsImage(_ data: Data) -> Bool {
        if data.count >= 4 {
            let head = [UInt8](data.prefix(4))
            if head == [0x89, 0x50, 0x4E, 0x47] { return true }  // PNG
            if head[0] == 0xFF, head[1] == 0xD8, head[2] == 0xFF { return true }  // JPEG
            if head == [0x47, 0x49, 0x46, 0x38] { return true }  // GIF8
            if head == [0x52, 0x49, 0x46, 0x46],  // RIFF....
                data.count >= 12, [UInt8](data[8..<12]) == [0x57, 0x45, 0x42, 0x50]
            { return true }  // WEBP
        }
        return false
    }

    private nonisolated static func describeLimit(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}
