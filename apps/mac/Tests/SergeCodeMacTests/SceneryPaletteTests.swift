import AppKit
import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Scenery palette extraction")
struct SceneryPaletteExtractionTests {
    @Test("solid image extraction is deterministic and dark-UI bounded")
    func deterministicSolidImage() throws {
        let image = try solidImage(
            NSColor(srgbRed: 0.12, green: 0.58, blue: 0.82, alpha: 1))

        let first = try #require(SceneryPaletteExtractor.extract(from: [image]))
        let second = try #require(SceneryPaletteExtractor.extract(from: [image]))

        #expect(first == second)
        let washes = try #require(first.washes)
        #expect(washes.count == SceneryPaletteExtractor.gradientPairCount)
        for pair in washes {
            #expect(pair.count == 2)
            let darkBrightness = try brightness(of: pair[0])
            let washBrightness = try brightness(of: pair[1])
            #expect((0.14...0.30).contains(darkBrightness))
            #expect((0.46...0.69).contains(washBrightness))
            #expect(washBrightness - darkBrightness >= 0.20)
        }

        let accentBrightness = try brightness(of: #require(first.accentHex))
        #expect((0.59...0.79).contains(accentBrightness))
    }

    private func solidImage(_ color: NSColor) throws -> NSImage {
        let size = 64
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let context = try #require(
            CGContext(
                data: nil,
                width: size,
                height: size,
                bitsPerComponent: 8,
                bytesPerRow: size * 4,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(color.cgColor)
        context.fill(CGRect(x: 0, y: 0, width: size, height: size))
        let cgImage = try #require(context.makeImage())
        return NSImage(cgImage: cgImage, size: NSSize(width: size, height: size))
    }

    private func brightness(of hex: String) throws -> Double {
        let value = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        let packed = try #require(UInt64(value, radix: 16))
        let red = Double((packed >> 16) & 0xFF) / 255
        let green = Double((packed >> 8) & 0xFF) / 255
        let blue = Double(packed & 0xFF) / 255
        return max(red, green, blue)
    }
}

@Suite("Scenery palette manifest")
struct SceneryPaletteManifestTests {
    @Test("palette encodes and decodes with the reserved manifest shape")
    func manifestRoundTrip() throws {
        let palette = SceneryPalette(
            accentHex: "#4F9AC3",
            washes: [
                ["#102A36", "#4A829F"],
                ["#241B35", "#735E8D"],
            ])
        let manifest = ScenerySet(
            id: "coast-test",
            title: "Coast",
            origin: .custom,
            createdAt: Date(timeIntervalSince1970: 1_700_000_000),
            queries: [SceneryQuery(text: "coast landscape")],
            sceneNames: ["Headland"],
            palette: palette)

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(manifest)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let decoded = try decoder.decode(ScenerySet.self, from: data)

        #expect(decoded == manifest)
        let json = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let encodedPalette = try #require(json["palette"] as? [String: Any])
        #expect(encodedPalette["accentHex"] as? String == "#4F9AC3")
        #expect((encodedPalette["washes"] as? [[String]])?.first == ["#102A36", "#4A829F"])
    }

    @Test("absent palette uses the pixel-identical Dolomites pair")
    func absentPaletteFallsBack() {
        let seed = "stable-thread"
        let manifest = ScenerySet.makeBuiltinDolomites()
        let resolved = AlpineTheme.gradientPair(seed: seed, palette: manifest.palette)
        let expected = AlpineTheme.dolomitesGradientPairs[
            AlpineTheme.stableIndex(seed, AlpineTheme.dolomitesGradientPairs.count)
        ]

        #expect(manifest.palette == nil)
        #expect(resolved == expected)
    }

    @Test("Phase-1 manifest JSON without palette key decodes with palette nil")
    func phase1ManifestWithoutPaletteKey() throws {
        // Phase-1 manifests predate the palette field. Decode must stay
        // backward-compatible so existing on-disk sets load with palette == nil.
        let json = """
            {
              "id": "kyoto-a1b2",
              "title": "Kyoto",
              "origin": "custom",
              "createdAt": "2024-01-15T12:00:00Z",
              "queries": [
                { "text": "kyoto temple autumn", "take": 8 }
              ],
              "sceneNames": ["Fushimi", "Arashiyama"]
            }
            """
        let data = Data(json.utf8)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let decoded = try decoder.decode(ScenerySet.self, from: data)

        #expect(decoded.id == "kyoto-a1b2")
        #expect(decoded.title == "Kyoto")
        #expect(decoded.origin == .custom)
        #expect(decoded.sceneNames == ["Fushimi", "Arashiyama"])
        #expect(decoded.queries.count == 1)
        #expect(decoded.queries[0].text == "kyoto temple autumn")
        #expect(decoded.palette == nil)
    }
}

@Suite("Scenery palette backfill")
@MainActor
struct SceneryPaletteBackfillTests {
    @Test("startup extracts a missing custom palette from downloaded images")
    func startupBackfill() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("scenery-palette-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let photo = SceneryPhoto(
            id: "coast-1",
            name: "Headland",
            averageColorHex: nil,
            heroURL: URL(string: "https://example.com/hero.jpg")!,
            thumbURL: URL(string: "https://example.com/thumb.jpg")!,
            rawURL: nil,
            downloadLocationURL: nil,
            photographerName: "Tester",
            photographerProfileURL: nil)
        let manifest = ScenerySet(
            id: "coast-test",
            title: "Coast",
            origin: .custom,
            createdAt: Date(timeIntervalSince1970: 1),
            queries: [SceneryQuery(text: "coast landscape")],
            sceneNames: ["Headland"])
        let writer = SceneryStore(client: nil, root: root)
        writer.reloadFromDiskForTesting()
        writer.registerSet(manifest, pool: [photo])

        let imageURL = root.appendingPathComponent("sets/coast-test/images/coast-1-thumb.jpg")
        let image = try solidImage()
        try #require(image.tiffRepresentation).write(to: imageURL, options: .atomic)

        let reader = SceneryStore(client: nil, root: root)
        await reader.start()
        let palette = try #require(reader.set(id: "coast-test")?.palette)
        #expect(palette.washes?.count == SceneryPaletteExtractor.gradientPairCount)

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let data = try Data(
            contentsOf: root.appendingPathComponent("sets/coast-test/manifest.json"))
        let persisted = try decoder.decode(ScenerySet.self, from: data)
        #expect(persisted.palette == palette)
        #expect(reader.set(id: ScenerySet.dolomitesID)?.palette == nil)
    }

    private func solidImage() throws -> NSImage {
        let size = 48
        let context = try #require(
            CGContext(
                data: nil,
                width: size,
                height: size,
                bitsPerComponent: 8,
                bytesPerRow: size * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(NSColor(srgbRed: 0.70, green: 0.34, blue: 0.16, alpha: 1).cgColor)
        context.fill(CGRect(x: 0, y: 0, width: size, height: size))
        return NSImage(
            cgImage: try #require(context.makeImage()),
            size: NSSize(width: size, height: size))
    }
}
