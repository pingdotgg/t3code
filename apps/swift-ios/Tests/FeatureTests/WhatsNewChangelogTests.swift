import Foundation
import Testing
import UIKit
@testable import T3Code

@Suite("What's New changelog")
struct WhatsNewChangelogTests {
    private let runningBundle: [String: Any] = [
        "CFBundleShortVersionString": "0.1.0",
        "CFBundleVersion": "90",
    ]

    private func embedded(_ json: String) -> String {
        Data(json.utf8).base64EncodedString()
    }

    private func payload(_ json: String) -> [String: Any] {
        var info = runningBundle
        info[WhatsNewChangelog.infoDictionaryKey] = embedded(json)
        return info
    }

    private let history = """
        {"builds":[
          {"version":"0.1.0","build":"88","entries":[{"title":"Command drawer"}]},
          {"version":"0.1.0","build":"90","entries":[
            {"title":"What's New history","summary":"Every build's entries ride along."},
            {"title":"Done for a duration"}
          ]},
          {"version":"0.1.0","build":"89","entries":[{"title":"Inline workspace images"}]}
        ]}
        """

    @Test
    func decodesEveryRecordedBuildNewestFirst() {
        let changelog = WhatsNewChangelog.decode(embedded(history))

        #expect(changelog?.builds.map(\.build) == ["90", "89", "88"])
        #expect(changelog?.builds.first?.entries.count == 2)
        #expect(changelog?.builds.first?.entries.first?.title == "What's New history")
        #expect(
            changelog?.builds.first?.entries.first?.summary == "Every build's entries ride along."
        )
        #expect(changelog?.builds.last?.entries.map(\.title) == ["Command drawer"])
    }

    @Test
    func leadsWithTheRunningBuildAndKeepsTheRestAsHistory() {
        let presentation = WhatsNewChangelog.load(info: payload(history))?
            .presentation(info: runningBundle)

        #expect(presentation?.current?.build == "90")
        #expect(presentation?.current?.label == "0.1.0 (90)")
        #expect(presentation?.current?.entries.count == 2)
        #expect(presentation?.earlier.map(\.build) == ["89", "88"])
        #expect(presentation?.earlier.map(\.label) == ["0.1.0 (89)", "0.1.0 (88)"])
    }

    @Test
    func readsEverythingAsHistoryWhenThePayloadDoesNotNameTheRunningBuild() {
        let json = """
            {"builds":[
              {"version":"0.1.0","build":"89","entries":[{"title":"Inline workspace images"}]},
              {"version":"0.1.0","build":"88","entries":[{"title":"Command drawer"}]}
            ]}
            """

        let presentation = WhatsNewChangelog.decode(embedded(json))?
            .presentation(info: runningBundle)

        #expect(presentation?.current == nil)
        #expect(presentation?.earlier.map(\.build) == ["89", "88"])
    }

    @Test
    func readsTheSingleBuildPayloadAsTheRunningBuild() {
        let json = #"{"entries":[{"title":"What's New screen","summary":"Opens from About."}]}"#

        let presentation = WhatsNewChangelog.load(info: payload(json))?
            .presentation(info: runningBundle)

        #expect(presentation?.current?.build == "90")
        #expect(presentation?.current?.label == "0.1.0 (90)")
        #expect(presentation?.current?.entries.map(\.title) == ["What's New screen"])
        #expect(presentation?.earlier.isEmpty == true)
    }

    @Test
    func keepsUnnumberedBuildsAfterTheNumberedHistoryInPayloadOrder() {
        let json = """
            {"builds":[
              {"version":"0.1.0","entries":[{"title":"Unnumbered first"}]},
              {"build":"5","entries":[{"title":"Numbered"}]},
              {"entries":[{"title":"Unnumbered second"}]}
            ]}
            """

        let changelog = WhatsNewChangelog.decode(embedded(json))

        #expect(
            changelog?.builds.flatMap({ $0.entries.map(\.title) })
                == ["Numbered", "Unnumbered first", "Unnumbered second"]
        )
        #expect(changelog?.builds.map(\.label) == ["Build 5", "0.1.0", nil])
    }

    @Test
    func readsOptionalDetailAndSymbolWhenAPublisherRecordsThem() {
        let json = """
            {"builds":[{"version":"0.1.0","build":"90","entries":[
              {
                "title":"What's New history",
                "summary":"Every build's entries ride along.",
                "detail":"  Each publisher appends its build to the history it inherited.  ",
                "symbol":"clock.arrow.circlepath"
              }
            ]}]}
            """

        let entry = WhatsNewChangelog.decode(embedded(json))?.builds.first?.entries.first

        #expect(entry?.hasDetail == true)
        #expect(entry?.detail == "Each publisher appends its build to the history it inherited.")
        #expect(entry?.symbolName == "clock.arrow.circlepath")
    }

    @Test
    func leavesEntriesInertWhenTheyRecordNoDetailAndFallsBackToTheDefaultSymbol() {
        let json = """
            {"builds":[{"version":"0.1.0","build":"90","entries":[
              {"title":"No detail recorded"},
              {"title":"Blank detail","detail":"   ","symbol":"   "},
              {"title":"Unknown symbol","symbol":"not.a.real.sf.symbol.name"}
            ]}]}
            """

        let entries = WhatsNewChangelog.decode(embedded(json))?.builds.first?.entries

        #expect(entries?.count == 3)
        #expect(entries?.allSatisfy { !$0.hasDetail } == true)
        #expect(entries?.allSatisfy { $0.detail == nil } == true)
        #expect(entries?.map(\.symbolName) == ["sparkles", "sparkles", "sparkles"])
    }

    @Test
    func rendersPayloadsWrittenBeforeDetailAndSymbolExistedExactlyAsBefore() {
        let entry = WhatsNewChangelog.load(info: payload(history))?
            .presentation(info: runningBundle)
            .current?
            .entries
            .first

        #expect(entry?.title == "What's New history")
        #expect(entry?.summary == "Every build's entries ride along.")
        #expect(entry?.detail == nil)
        #expect(entry?.hasDetail == false)
        #expect(entry?.symbolName == "sparkles")
    }

    @Test
    func readsOptionalImagesAndMakesImageOnlyEntriesOpenable() {
        let json = """
            {"builds":[{"version":"0.1.0","build":"90","entries":[
              {"title":"With pictures","images":[
                {"name":"  whatsnew-90-history.png  ","caption":"  The history screen.  "},
                {"name":"whatsnew-90-detail.png"},
                {"name":"   "}
              ]},
              {"title":"Pictures only","images":[{"name":"whatsnew-90-only.png"}]}
            ]}]}
            """

        let entries = WhatsNewChangelog.decode(embedded(json))?.builds.first?.entries

        #expect(entries?.first?.images?.count == 2)
        #expect(entries?.first?.images?.first?.name == "whatsnew-90-history.png")
        #expect(entries?.first?.images?.first?.caption == "The history screen.")
        #expect(entries?.first?.images?.last?.caption == nil)
        // An entry that ships only screenshots still has something to show.
        #expect(entries?.last?.detail == nil)
        #expect(entries?.last?.hasDetail == true)
    }

    @Test
    func picksTheDarkVariantOnlyInDarkModeAndOnlyWhenRecorded() {
        let json = """
            {"builds":[{"build":"90","entries":[{"title":"Appearance","images":[
              {"name":"shot.png","darkName":"  shot-dark.png  ","caption":"Both variants."},
              {"name":"single.png"},
              {"name":"blank-dark.png","darkName":"   "}
            ]}]}]}
            """

        let images = WhatsNewChangelog.decode(embedded(json))?
            .builds.first?.entries.first?.images

        #expect(images?.count == 3)
        // Recorded dark variant, whitespace trimmed.
        #expect(images?.first?.darkName == "shot-dark.png")
        #expect(images?.first?.name(inDarkMode: true) == "shot-dark.png")
        #expect(images?.first?.name(inDarkMode: false) == "shot.png")
        // No dark variant recorded: the one screenshot serves both appearances.
        #expect(images?[1].darkName == nil)
        #expect(images?[1].name(inDarkMode: true) == "single.png")
        #expect(images?[1].name(inDarkMode: false) == "single.png")
        // A blank dark name counts as unrecorded rather than as a file name.
        #expect(images?[2].darkName == nil)
        #expect(images?[2].name(inDarkMode: true) == "blank-dark.png")
    }

    @Test
    func fallsBackToTheLightFileWhenTheDarkOneIsNamedButNotShipped() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("whats-new-appearance-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: directory) }

        let light = try #require(UIImage(systemName: "sun.max")?.pngData())
        let dark = try #require(UIImage(systemName: "moon.stars")?.pngData())
        try light.write(to: directory.appendingPathComponent("shot.png"))
        try dark.write(to: directory.appendingPathComponent("shot-dark.png"))
        try light.write(to: directory.appendingPathComponent("single.png"))

        let bothVariants = WhatsNewChangelog.Image(
            name: "shot.png",
            darkName: "shot-dark.png",
            caption: nil
        )
        let lightOnly = WhatsNewChangelog.Image(name: "single.png", darkName: nil, caption: nil)
        let darkMissing = WhatsNewChangelog.Image(
            name: "single.png",
            darkName: "single-dark.png",
            caption: nil
        )
        let nothingShipped = WhatsNewChangelog.Image(
            name: "absent.png",
            darkName: "absent-dark.png",
            caption: nil
        )

        let darkBytes = WhatsNewImageStore
            .image(for: bothVariants, isDark: true, in: directory)?.pngData()
        let lightBytes = WhatsNewImageStore
            .image(for: bothVariants, isDark: false, in: directory)?.pngData()
        #expect(darkBytes != nil)
        #expect(lightBytes != nil)
        #expect(darkBytes != lightBytes)

        // One recorded screenshot serves both appearances.
        #expect(WhatsNewImageStore.image(for: lightOnly, isDark: true, in: directory) != nil)
        // A dark variant that was named but never shipped falls back to the light file.
        #expect(WhatsNewImageStore.image(for: darkMissing, isDark: true, in: directory) != nil)
        // Neither variant shipped: still no image, still no broken page.
        #expect(WhatsNewImageStore.image(for: nothingShipped, isDark: true, in: directory) == nil)
        #expect(WhatsNewImageStore.image(for: nothingShipped, isDark: false, in: directory) == nil)
    }

    @Test
    func capsTheNumberOfImagesAnEntryCanBuild() {
        let names = (1...10).map { #"{"name":"shot-\#($0).png"}"# }.joined(separator: ",")
        let json = #"{"builds":[{"build":"90","entries":[{"title":"Gallery","images":[\#(names)]}]}]}"#

        let entry = WhatsNewChangelog.decode(embedded(json))?.builds.first?.entries.first

        #expect(entry?.images?.count == WhatsNewChangelog.Entry.maximumImages)
        #expect(entry?.images?.first?.name == "shot-1.png")
    }

    @Test
    func rendersPayloadsWithoutImagesExactlyAsBefore() {
        let entry = WhatsNewChangelog.load(info: payload(history))?
            .presentation(info: runningBundle)
            .current?
            .entries
            .first

        #expect(entry?.images == nil)
        #expect(entry?.hasDetail == false)
        #expect(entry?.title == "What's New history")
        #expect(entry?.summary == "Every build's entries ride along.")
    }

    @Test
    func resolvesOnlyUsableImageFilesFromTheBundleDirectory() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("whats-new-images-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: directory) }

        let png = try #require(UIImage(systemName: "sparkles")?.pngData())
        try png.write(to: directory.appendingPathComponent("good.png"))
        try Data("not an image".utf8).write(to: directory.appendingPathComponent("bogus.png"))
        try Data(count: WhatsNewImageStore.maximumImageBytes + 1)
            .write(to: directory.appendingPathComponent("huge.png"))
        try Data().write(to: directory.appendingPathComponent("empty.png"))

        // Usable file resolves and decodes.
        #expect(WhatsNewImageStore.imageURL(named: "good.png", in: directory) != nil)
        #expect(WhatsNewImageStore.image(named: "good.png", in: directory) != nil)
        // Everything a sloppy or hostile payload can name resolves to nothing.
        #expect(WhatsNewImageStore.imageURL(named: "huge.png", in: directory) == nil)
        #expect(WhatsNewImageStore.imageURL(named: "empty.png", in: directory) == nil)
        #expect(WhatsNewImageStore.imageURL(named: "missing.png", in: directory) == nil)
        #expect(WhatsNewImageStore.imageURL(named: "", in: directory) == nil)
        #expect(WhatsNewImageStore.imageURL(named: "   ", in: directory) == nil)
        #expect(WhatsNewImageStore.imageURL(named: "..", in: directory) == nil)
        #expect(WhatsNewImageStore.imageURL(named: "../good.png", in: directory) == nil)
        #expect(WhatsNewImageStore.imageURL(named: "nested/good.png", in: directory) == nil)
        #expect(WhatsNewImageStore.imageURL(named: "good\u{0}.png", in: directory) == nil)
        // A file that exists but is not an image renders as no image at all.
        #expect(WhatsNewImageStore.image(named: "bogus.png", in: directory) == nil)
    }

    @Test
    func treatsAnythingABuildMightLeaveBehindAsNoChangelog() {
        let payloads: [String] = [
            "$(T3_BUILD_CHANGELOG)",
            "",
            "   ",
            "not base64 at all!!",
            embedded("this is not json"),
            embedded(#"{"builds":[]}"#),
            embedded(#"{"entries":[]}"#),
            embedded(#"{"builds":[{"build":"90","entries":[{"title":"   "}]}]}"#),
            embedded(#"{"releases":[]}"#),
        ]

        for payload in payloads {
            #expect(
                WhatsNewChangelog.decode(payload) == nil,
                "expected no changelog for \(payload)"
            )
        }
    }

    @Test
    func readsThePayloadFromTheBundleKeyAndHidesWhenItIsAbsent() {
        #expect(WhatsNewChangelog.load(info: payload(history))?.builds.count == 3)
        #expect(WhatsNewChangelog.load(info: runningBundle) == nil)
        #expect(WhatsNewChangelog.load(info: nil) == nil)
        #expect(
            WhatsNewChangelog.load(info: [WhatsNewChangelog.infoDictionaryKey: 42]) == nil
        )
    }

    @Test
    func trimsEntryTextAndDropsTitlelessEntriesAndEmptyBuilds() {
        let json = """
            {"builds":[
              {"build":"  90  ","version":"  0.1.0  ","entries":[
                {"title":"  Recent projects  ","summary":"  Picker remembers what you opened.  "},
                {"title":"","summary":"orphan summary"},
                {"title":"Timestamps","summary":"   "}
              ]},
              {"build":"89","entries":[{"title":"  "}]}
            ]}
            """

        let changelog = WhatsNewChangelog.decode(embedded(json))

        #expect(changelog?.builds.count == 1)
        #expect(changelog?.builds.first?.build == "90")
        #expect(changelog?.builds.first?.version == "0.1.0")
        #expect(changelog?.builds.first?.entries.count == 2)
        #expect(changelog?.builds.first?.entries.first?.title == "Recent projects")
        #expect(
            changelog?.builds.first?.entries.first?.summary == "Picker remembers what you opened."
        )
        #expect(changelog?.builds.first?.entries.last?.summary == nil)
    }

    @Test
    func buildLabelCombinesVersionAndBuildOnlyWhenBothAreRecorded() {
        #expect(WhatsNewChangelog.buildLabel(info: runningBundle) == "0.1.0 (90)")
        #expect(
            WhatsNewChangelog.buildLabel(
                info: [
                    "CFBundleShortVersionString": "$(MARKETING_VERSION)",
                    "CFBundleVersion": "90",
                ]
            ) == nil
        )
        #expect(
            WhatsNewChangelog.buildLabel(info: ["CFBundleShortVersionString": "0.1.0"]) == nil
        )
        #expect(WhatsNewChangelog.buildLabel(info: nil) == nil)
    }
}
