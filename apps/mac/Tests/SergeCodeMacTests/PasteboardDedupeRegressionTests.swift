import AppKit
import Foundation
import Testing

@testable import SergeCodeMac

/// Cmd+V in the composer reads whatever the pasteboard offers. Two rules have
/// to hold: one copied picture becomes exactly one attachment no matter how
/// many flavors carry it, and the read stays bounded because it runs inline in
/// key-event dispatch.
@Suite("Pasteboard image dedupe")
@MainActor
struct PasteboardDedupeRegressionTests {
    // MARK: - Fixtures

    /// Private pasteboard so tests never touch (or depend on) the user's
    /// clipboard.
    private func scratchPasteboard() -> NSPasteboard {
        NSPasteboard(name: NSPasteboard.Name("sergecode-tests-\(UUID().uuidString)"))
    }

    private final class TempDir {
        let url: URL

        init() throws {
            url = FileManager.default.temporaryDirectory
                .appendingPathComponent("pasteboard-dedupe-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        }

        deinit { try? FileManager.default.removeItem(at: url) }
    }

    /// A tiny solid-color bitmap, returned in both flavors the composer reads.
    private func sampleImage(red: CGFloat) throws -> (png: Data, tiff: Data) {
        let image = NSImage(size: NSSize(width: 4, height: 4))
        image.lockFocus()
        NSColor(red: red, green: 0.2, blue: 0.3, alpha: 1).setFill()
        NSRect(x: 0, y: 0, width: 4, height: 4).fill()
        image.unlockFocus()
        let tiff = try #require(image.tiffRepresentation)
        let rep = try #require(NSBitmapImageRep(data: tiff))
        let png = try #require(rep.representation(using: .png, properties: [:]))
        return (png, tiff)
    }

    // MARK: - Flavor dedupe

    @Test("PNG and TIFF flavors of one copy yield a single attachment")
    func singlePayloadForMultipleFlavors() throws {
        let image = try sampleImage(red: 0.9)
        let pasteboard = scratchPasteboard()
        pasteboard.declareTypes([.png, .tiff], owner: nil)
        pasteboard.setData(image.png, forType: .png)
        pasteboard.setData(image.tiff, forType: .tiff)

        let payloads = Pasteboard.imagePayloads(from: pasteboard)

        #expect(payloads.count == 1)
        // Table order prefers the original PNG bytes over a TIFF re-encode.
        #expect(payloads.first?.mimeType == "image/png")
        #expect(payloads.first?.data == image.png)
        #expect(payloads.first?.name == "Pasted image 1.png")
    }

    @Test("TIFF-only copies still normalize to PNG")
    func tiffOnlyNormalizesToPNG() throws {
        let image = try sampleImage(red: 0.4)
        let pasteboard = scratchPasteboard()
        pasteboard.declareTypes([.tiff], owner: nil)
        pasteboard.setData(image.tiff, forType: .tiff)

        let payloads = Pasteboard.imagePayloads(from: pasteboard)

        #expect(payloads.count == 1)
        #expect(payloads.first?.mimeType == "image/png")
        #expect(payloads.first?.name == "Pasted image 1.png")
    }

    @Test("File copies win; raw flavors of the same copy are not appended again")
    func fileURLCopySuppressesRawFlavors() throws {
        let image = try sampleImage(red: 0.7)
        let dir = try TempDir()
        let file = dir.url.appendingPathComponent("shot.png")
        try image.png.write(to: file)

        let pasteboard = scratchPasteboard()
        pasteboard.clearContents()
        pasteboard.writeObjects([file as NSURL])
        pasteboard.setData(image.tiff, forType: .tiff)

        let payloads = Pasteboard.imagePayloads(from: pasteboard)

        #expect(payloads.count == 1)
        #expect(payloads.first?.name == "shot.png")
    }

    // MARK: - Bounded reads

    @Test("Limit caps how many copied files are read off disk")
    func limitBoundsFileReads() throws {
        let dir = try TempDir()
        var urls: [NSURL] = []
        for index in 0..<3 {
            let image = try sampleImage(red: CGFloat(index) / 3)
            let file = dir.url.appendingPathComponent("shot-\(index).png")
            try image.png.write(to: file)
            urls.append(file as NSURL)
        }

        let pasteboard = scratchPasteboard()
        pasteboard.clearContents()
        pasteboard.writeObjects(urls)

        #expect(Pasteboard.imagePayloads(from: pasteboard, limit: 2).count == 2)
        #expect(Pasteboard.imagePayloads(from: pasteboard, limit: 1).count == 1)
        #expect(Pasteboard.imagePayloads(from: pasteboard).count == 3)
    }

    @Test("Text-only pasteboards produce no payloads")
    func textOnlyPasteboardIsEmpty() {
        let pasteboard = scratchPasteboard()
        pasteboard.declareTypes([.string], owner: nil)
        pasteboard.setString("just text", forType: .string)

        #expect(Pasteboard.imagePayloads(from: pasteboard).isEmpty)
    }
}
