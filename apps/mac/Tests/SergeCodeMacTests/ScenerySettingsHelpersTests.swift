import AppKit
import Foundation
import SwiftUI
import Testing

@testable import SergeCodeMac

@Suite("SceneSetComposer user messages")
struct SceneSetComposerUserMessageTests {
    @Test("invalid location")
    func invalidLocation() {
        let message = SceneSetComposerUserMessage.message(for: .invalidLocation)
        #expect(message.contains("location"))
    }

    @Test("missing Unsplash key names file path and env var")
    func missingKey() {
        let message = SceneSetComposerUserMessage.message(for: .missingUnsplashKey)
        #expect(message.contains("SERGECODE_UNSPLASH_KEY"))
        #expect(message.contains("unsplash-access-key"))
        #expect(message.contains("Application Support/SergeCode"))
    }

    @Test("backend failure prefers detail")
    func backendFailure() {
        let withDetail = SceneSetComposerUserMessage.message(for: .backendFailure("RPC down"))
        #expect(withDetail == "RPC down")
        let empty = SceneSetComposerUserMessage.message(for: .backendFailure(""))
        #expect(empty.contains("provider") || empty.contains("generate"))
    }

    @Test("no photos and cancelled")
    func otherErrors() {
        #expect(
            SceneSetComposerUserMessage.message(for: .noPhotosFound)
                .localizedCaseInsensitiveContains("photo"))
        #expect(
            SceneSetComposerUserMessage.message(for: .cancelled)
                .localizedCaseInsensitiveContains("cancel"))
    }
}

@Suite("Scenery accent color codec")
struct SceneryAccentColorCodecTests {
    @Test("hex round-trip")
    func hexRoundTrip() throws {
        let original = "#4C755C"
        let color = try #require(SceneryAccentColorCodec.color(from: original))
        let encoded = try #require(SceneryAccentColorCodec.hex(from: color))
        #expect(encoded.uppercased() == original.uppercased())
    }

    @Test("nil and invalid hex")
    func invalid() {
        #expect(SceneryAccentColorCodec.color(from: nil) == nil)
        #expect(SceneryAccentColorCodec.color(from: "not-a-color") == nil)
        #expect(SceneryAccentColorCodec.color(from: "#GG0000") == nil)
    }

    @Test("RGB hexString format")
    func rgbHexString() {
        let rgb = AlpineTheme.RGB(red: 1, green: 0, blue: 0.5)
        #expect(rgb.hexString == "#FF0080")
    }

    @Test("convertible color updates accent over previous")
    func accentHexUpdatesWhenConvertible() throws {
        let color = Color(red: 1, green: 0, blue: 0)
        let next = try #require(
            SceneryAccentColorCodec.accentHex(from: color, preserving: "#000000"))
        #expect(next.uppercased() == "#FF0000")
    }

    @Test("conversion failure preserves previous accent (wide-gamut / non-RGB path)")
    func accentHexPreservesOnConversionFailure() {
        // Pattern colors have no RGB components — AppKit's sRGB conversion is nil.
        let pattern = NSColor(patternImage: NSImage(size: NSSize(width: 1, height: 1)))
        #expect(pattern.usingColorSpace(.sRGB) == nil)

        let previous = "#4C755C"
        let color = Color(nsColor: pattern)
        // Color-well write path must not clear a saved accent when hex fails.
        #expect(SceneryAccentColorCodec.hex(from: color) == nil)
        #expect(
            SceneryAccentColorCodec.accentHex(from: color, preserving: previous) == previous)
        #expect(SceneryAccentColorCodec.accentHex(from: color, preserving: nil) == nil)
    }
}

@Suite("Scenery project symbols")
struct SceneryProjectSymbolsTests {
    @Test("curated list is non-empty and unique")
    func curated() {
        #expect(SceneryProjectSymbols.curated.count >= 16)
        #expect(SceneryProjectSymbols.curated.count == Set(SceneryProjectSymbols.curated).count)
        #expect(SceneryProjectSymbols.curated.contains("folder"))
        #expect(SceneryProjectSymbols.curated.contains("terminal"))
        #expect(SceneryProjectSymbols.curated.contains("leaf"))
        #expect(SceneryProjectSymbols.curated.contains("globe"))
    }
}

@Suite("Scenery translucency settings")
struct SceneryTranslucencySettingsTests {
    @Test("clamp keeps legal values and bounds extremes")
    func clamp() {
        #expect(ScenerySettingsFile.clampTranslucency(0.85) == 0.85)
        #expect(ScenerySettingsFile.clampTranslucency(0.5) == 0.5)
        #expect(ScenerySettingsFile.clampTranslucency(1.0) == 1.0)
        #expect(ScenerySettingsFile.clampTranslucency(0.0) == 0.5)
        #expect(ScenerySettingsFile.clampTranslucency(-1) == 0.5)
        #expect(ScenerySettingsFile.clampTranslucency(1.5) == 1.0)
        #expect(ScenerySettingsFile.clampTranslucency(2) == 1.0)
    }

    @Test("init clamps translucency")
    func initClamps() {
        #expect(ScenerySettingsFile(sceneryTranslucency: 0.2).sceneryTranslucency == 0.5)
        #expect(ScenerySettingsFile(sceneryTranslucency: 1.2).sceneryTranslucency == 1.0)
        #expect(
            ScenerySettingsFile().sceneryTranslucency
                == ScenerySettingsFile.defaultTranslucency)
    }

    @Test("wash scale is 1.0 at full opacity and stays high at 50%")
    func washScale() {
        #expect(ScenerySettingsFile.washScale(forTranslucency: 1.0) == 1.0)
        #expect(ScenerySettingsFile.washScale(forTranslucency: 0.85) == 0.7 + 0.3 * 0.85)
        let half = ScenerySettingsFile.washScale(forTranslucency: 0.5)
        #expect(half == 0.85)
        // Below range clamps first, so wash still matches the floor.
        #expect(ScenerySettingsFile.washScale(forTranslucency: 0.0) == half)
    }

    @Test("decode missing translucency uses default; out-of-range is clamped")
    func decode() throws {
        let decoder = JSONDecoder()
        let legacy = Data(#"{"defaultSetId":"dolomites"}"#.utf8)
        let fromLegacy = try decoder.decode(ScenerySettingsFile.self, from: legacy)
        #expect(fromLegacy.defaultSetId == "dolomites")
        #expect(fromLegacy.sceneryTranslucency == ScenerySettingsFile.defaultTranslucency)

        let high = Data(#"{"defaultSetId":"dolomites","sceneryTranslucency":1.4}"#.utf8)
        #expect(
            try decoder.decode(ScenerySettingsFile.self, from: high).sceneryTranslucency == 1.0)

        let low = Data(#"{"defaultSetId":"dolomites","sceneryTranslucency":0.1}"#.utf8)
        #expect(
            try decoder.decode(ScenerySettingsFile.self, from: low).sceneryTranslucency == 0.5)
    }

    @Test("encode/decode round-trip")
    func roundTrip() throws {
        let original = ScenerySettingsFile(
            defaultSetId: "patagonia", sceneryTranslucency: 0.62)
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(ScenerySettingsFile.self, from: data)
        #expect(decoded == original)
    }
}

@Suite("SceneryStore translucency persistence")
@MainActor
struct SceneryStoreTranslucencyPersistenceTests {
    private func tempRoot() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("scenery-translucency-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    @Test("default translucency and disk round-trip")
    func persist() throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        let writer = SceneryStore(client: nil, root: root)
        writer.reloadFromDiskForTesting()
        #expect(writer.sceneryTranslucency == ScenerySettingsFile.defaultTranslucency)

        writer.setSceneryTranslucency(0.55)
        #expect(writer.sceneryTranslucency == 0.55)

        // Out of range clamps and still persists.
        writer.setSceneryTranslucency(0.1)
        #expect(writer.sceneryTranslucency == 0.5)

        let reader = SceneryStore(client: nil, root: root)
        reader.reloadFromDiskForTesting()
        #expect(reader.sceneryTranslucency == 0.5)
    }
}

@Suite("SceneryStore photos for set")
@MainActor
struct SceneryStorePhotosForSetTests {
    private func tempRoot() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("scenery-photos-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    @Test("photos(forSetId:) returns registered pool")
    func photosForSet() throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SceneryStore(client: nil, root: root)
        store.reloadFromDiskForTesting()

        let photo = SceneryPhoto(
            id: "p1",
            name: "Ridge",
            averageColorHex: "#112233",
            heroURL: URL(string: "https://example.com/h.jpg")!,
            thumbURL: URL(string: "https://example.com/t.jpg")!,
            photographerName: "Test")
        let set = ScenerySet(
            id: "kyoto-test",
            title: "Kyoto",
            origin: .custom,
            createdAt: Date(),
            queries: [SceneryQuery(text: "kyoto")],
            sceneNames: ["Ridge"])
        store.registerSetForTesting(set, pool: [photo])

        #expect(store.photos(forSetId: "kyoto-test").map(\.id) == ["p1"])
        #expect(store.photos(forSetId: "missing").isEmpty)
    }
}
