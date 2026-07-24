import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Attachment file encoder")
struct AttachmentFileEncoderTests {
    /// Small caps so tests stay fast; the composer passes its real 8 / 10 MB
    /// limits through the same parameters.
    private let maxAttachments = 3
    private let maxBytes = 1024

    // MARK: - Fixtures

    private final class TempDir {
        let url: URL

        init() throws {
            url = FileManager.default.temporaryDirectory
                .appendingPathComponent("attachment-encoder-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        }

        deinit { try? FileManager.default.removeItem(at: url) }

        @discardableResult
        func file(_ name: String, bytes: Int = 16, contents: Data? = nil) throws -> URL {
            let fileURL = url.appendingPathComponent(name)
            try (contents ?? Data(repeating: 0x61, count: bytes)).write(to: fileURL)
            return fileURL
        }

        func folder(_ name: String) throws -> URL {
            let folderURL = url.appendingPathComponent(name, isDirectory: true)
            try FileManager.default.createDirectory(
                at: folderURL, withIntermediateDirectories: true)
            return folderURL
        }
    }

    private func encode(
        _ urls: [URL], existing: [OutgoingAttachment] = []
    ) async -> (attachments: [OutgoingAttachment], error: String?) {
        await AttachmentFileEncoder.encodeFromFiles(
            urls: urls, existing: existing,
            maxAttachments: maxAttachments, maxAttachmentBytes: maxBytes)
    }

    private func existingAttachment(name: String, sizeBytes: Int) -> OutgoingAttachment {
        OutgoingAttachment(
            id: UUID().uuidString, name: name, mimeType: "image/png", sizeBytes: sizeBytes,
            dataURL: "data:image/png;base64,AA==")
    }

    // MARK: - Happy paths

    @Test("a single supported image file becomes an attachment")
    func singleImageFile() async throws {
        let dir = try TempDir()
        let url = try dir.file("photo.png", bytes: 42)

        let (attachments, error) = await encode([url])

        #expect(error == nil)
        #expect(attachments.count == 1)
        let attachment = try #require(attachments.first)
        #expect(attachment.name == "photo.png")
        #expect(attachment.mimeType == "image/png")
        #expect(attachment.sizeBytes == 42)
        #expect(attachment.dataURL.hasPrefix("data:image/png;base64,"))
    }

    @Test("multiple files keep deterministic drop order")
    func multipleFilesKeepOrder() async throws {
        let dir = try TempDir()
        let first = try dir.file("b-first.png")
        let second = try dir.file("a-second.jpg")
        let third = try dir.file("c-third.png")

        let (attachments, error) = await encode([first, second, third])

        #expect(error == nil)
        #expect(attachments.map(\.name) == ["b-first.png", "a-second.jpg", "c-third.png"])
        #expect(attachments.map(\.mimeType) == ["image/png", "image/jpeg", "image/png"])
    }

    @Test("an extensionless file with image bytes attaches via sniffing")
    func extensionlessImageSniffed() async throws {
        let dir = try TempDir()
        let pngMagic = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
        let url = try dir.file("no-extension", contents: pngMagic + Data(repeating: 0, count: 8))

        let (attachments, error) = await encode([url])

        #expect(error == nil)
        #expect(attachments.count == 1)
        #expect(attachments.first?.mimeType == "image/png")
    }

    @Test("supported files around rejected ones still attach, in order")
    func mixedBatchKeepsValidFiles() async throws {
        let dir = try TempDir()
        let good1 = try dir.file("good-1.png")
        let bad = try dir.file("notes.txt")
        let good2 = try dir.file("good-2.png")

        let (attachments, error) = await encode([good1, bad, good2])

        #expect(error == "notes.txt is not an image.")
        #expect(attachments.map(\.name) == ["good-1.png", "good-2.png"])
    }

    // MARK: - Rejections

    @Test("non-image files are rejected with an explanation")
    func nonImageRejected() async throws {
        let dir = try TempDir()
        let url = try dir.file("notes.txt")

        let (attachments, error) = await encode([url])

        #expect(attachments.isEmpty)
        #expect(error == "notes.txt is not an image.")
    }

    @Test("an extensionless non-image file is rejected")
    func extensionlessNonImageRejected() async throws {
        let dir = try TempDir()
        let url = try dir.file("mystery", contents: Data(repeating: 0x61, count: 32))

        let (attachments, error) = await encode([url])

        #expect(attachments.isEmpty)
        #expect(error == "mystery is not an image.")
    }

    @Test("files over the size limit are rejected")
    func oversizedRejected() async throws {
        let dir = try TempDir()
        let url = try dir.file("huge.png", bytes: maxBytes + 1)

        let (attachments, error) = await encode([url])

        #expect(attachments.isEmpty)
        #expect(error?.contains("huge.png is over the") == true)
        #expect(error?.contains("attachment limit.") == true)
    }

    @Test("folders are rejected with a folder-specific explanation")
    func folderRejected() async throws {
        let dir = try TempDir()
        let folder = try dir.folder("SomeFolder")

        let (attachments, error) = await encode([folder])

        #expect(attachments.isEmpty)
        #expect(error == "SomeFolder is a folder — attach the files inside it instead.")
    }

    @Test("packages are rejected with a package-specific explanation")
    func packageRejected() async throws {
        let dir = try TempDir()
        let package = try dir.folder("Fake.app")
        let isPackage =
            (try? package.resourceValues(forKeys: [.isPackageKey]))?.isPackage == true

        let (attachments, error) = await encode([package])

        #expect(attachments.isEmpty)
        if isPackage {
            #expect(error == "Fake.app is a package and can't be attached.")
        } else {
            // Filesystems that don't report the package bit still reject it
            // as a folder.
            #expect(error == "Fake.app is a folder — attach the files inside it instead.")
        }
    }

    @Test("missing files are rejected with a not-found explanation")
    func missingFileRejected() async throws {
        let dir = try TempDir()
        let missing = dir.url.appendingPathComponent("ghost.png")

        let (attachments, error) = await encode([missing])

        #expect(attachments.isEmpty)
        #expect(error == "Could not find ghost.png.")
    }

    @Test("unreadable files are rejected with an access explanation")
    func unreadableFileRejected() async throws {
        let dir = try TempDir()
        let url = try dir.file("locked.png")
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: url.path)
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: url.path)
        }

        let (attachments, error) = await encode([url])

        #expect(attachments.isEmpty)
        #expect(error == "macOS denied access to locked.png.")
    }

    @Test("the same file dropped twice in one batch attaches once")
    func duplicateInBatchRejected() async throws {
        let dir = try TempDir()
        let url = try dir.file("twice.png")

        let (attachments, error) = await encode([url, url])

        #expect(attachments.map(\.name) == ["twice.png"])
        #expect(error == "twice.png was dropped more than once.")
    }

    @Test("a file already staged in the draft is rejected as a duplicate")
    func duplicateOfExistingRejected() async throws {
        let dir = try TempDir()
        let url = try dir.file("staged.png", bytes: 24)
        let existing = [existingAttachment(name: "staged.png", sizeBytes: 24)]

        let (attachments, error) = await encode([url], existing: existing)

        #expect(attachments.isEmpty)
        #expect(error == "staged.png is already attached.")
    }

    @Test("the attachment cap counts already-staged attachments")
    func capCountsExisting() async throws {
        let dir = try TempDir()
        let url = try dir.file("extra.png")
        let existing = (0..<maxAttachments).map {
            existingAttachment(name: "e\($0).png", sizeBytes: $0 + 1)
        }

        let (attachments, error) = await encode([url], existing: existing)

        #expect(attachments.isEmpty)
        #expect(error == "At most \(maxAttachments) attachments per message.")
    }

    @Test("the cap stops a batch partway through")
    func capStopsBatch() async throws {
        let dir = try TempDir()
        let urls = try (0..<maxAttachments + 2).map { try dir.file("f\($0).png") }

        let (attachments, error) = await encode(urls)

        #expect(attachments.map(\.name) == ["f0.png", "f1.png", "f2.png"])
        #expect(error == "At most \(maxAttachments) attachments per message.")
    }

    // MARK: - In-memory bytes (paste / image-drop path)

    @Test("in-memory image bytes encode with the same caps")
    func encodeFromData() async throws {
        let items = [
            (name: "small.png", mimeType: "image/png", data: Data(repeating: 1, count: 10)),
            (name: "big.png", mimeType: "image/png", data: Data(repeating: 2, count: maxBytes + 1)),
        ]

        let (attachments, error) = await AttachmentFileEncoder.encodeFromData(
            items, existingCount: 0,
            maxAttachments: maxAttachments, maxAttachmentBytes: maxBytes)

        #expect(attachments.map(\.name) == ["small.png"])
        #expect(error?.contains("big.png is over the") == true)
    }
}
