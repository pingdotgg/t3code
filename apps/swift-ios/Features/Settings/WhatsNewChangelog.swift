import Foundation
import UIKit

/// The changelog a build carries: what shipped in the running build, and what
/// shipped in the builds before it.
///
/// The payload rides in the app bundle as base64-encoded JSON under the
/// `T3BuildChangelog` Info.plist key, expanded from the `T3_BUILD_CHANGELOG`
/// build setting at build time — the same injection-only shape used to record
/// build identity. Each publisher appends its own build to the history it
/// inherited, so the newest build leads and every earlier build rides along:
///
/// ```json
/// {"builds":[
///   {"version":"0.1.0","build":"90","entries":[{"title":"…","summary":"…"}]},
///   {"version":"0.1.0","build":"89","entries":[{"title":"…"}]}
/// ]}
/// ```
///
/// A build that injects nothing simply has no changelog, and the Settings entry
/// point hides rather than showing a placeholder.
struct WhatsNewChangelog: Equatable, Sendable {
    /// A screenshot a build shipped in its bundle, referenced by file name.
    ///
    /// A build may ship one file per appearance. `darkName` is optional, so an
    /// entry that only ever recorded one screenshot keeps showing it in both
    /// appearances rather than showing nothing in one of them.
    struct Image: Codable, Equatable, Sendable {
        let name: String
        let darkName: String?
        let caption: String?

        func name(inDarkMode isDark: Bool) -> String {
            guard isDark, let darkName else { return name }
            return darkName
        }
    }

    struct Entry: Codable, Equatable, Sendable {
        let title: String
        let summary: String?
        /// Long-form copy shown when the entry is opened. An entry without it
        /// stays inert — no chevron, nothing to tap.
        let detail: String?
        /// SF Symbol recorded by the publisher; ignored when the running OS
        /// does not have it, so a typo degrades to the default rather than to
        /// an empty tile.
        let symbol: String?
        /// Screenshots shipped in the app bundle for this entry, shown on the
        /// detail page. Absent for entries that ship none.
        let images: [Image]?

        var hasDetail: Bool { detail != nil || !(images ?? []).isEmpty }

        var symbolName: String {
            guard let symbol, UIImage(systemName: symbol) != nil else { return "sparkles" }
            return symbol
        }
    }

    struct Build: Codable, Equatable, Sendable {
        let version: String?
        let build: String?
        let entries: [Entry]

        /// `0.1.0 (89)` when both are recorded, and the best of the two when
        /// only one is.
        var label: String? {
            switch (version, build) {
            case let (version?, build?): "\(version) (\(build))"
            case let (nil, build?): "Build \(build)"
            case let (version?, nil): version
            case (nil, nil): nil
            }
        }

        var buildNumber: Int? { build.flatMap(Int.init) }
    }

    /// Newest build first.
    let builds: [Build]

    static let infoDictionaryKey = "T3BuildChangelog"

    static func load(info: [String: Any]?) -> WhatsNewChangelog? {
        guard let encoded = info?[infoDictionaryKey] as? String else { return nil }
        return decode(encoded, info: info)
    }

    /// Decodes an embedded payload, returning `nil` for anything a build can
    /// plausibly leave behind: an absent value, an unexpanded `$(…)` setting,
    /// something that is not base64 JSON, or a changelog with nothing to say.
    ///
    /// A payload carrying bare `entries` instead of `builds` is the single-build
    /// shape this feature shipped with first; it is read as the running build's
    /// own entries.
    static func decode(_ encoded: String, info: [String: Any]? = nil) -> WhatsNewChangelog? {
        let trimmed = encoded.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              !trimmed.hasPrefix("$("),
              let data = Data(base64Encoded: trimmed),
              let payload = try? JSONDecoder().decode(Payload.self, from: data)
        else { return nil }

        let decoded: [Build]
        if let builds = payload.builds {
            decoded = builds
        } else if let entries = payload.entries {
            decoded = [
                Build(
                    version: metadataValue("CFBundleShortVersionString", info: info),
                    build: metadataValue("CFBundleVersion", info: info),
                    entries: entries
                )
            ]
        } else {
            return nil
        }

        let builds = decoded.compactMap(\.normalized)
        guard !builds.isEmpty else { return nil }
        return WhatsNewChangelog(builds: ordered(builds))
    }

    /// Splits the history into the running build and everything before it. When
    /// the payload does not name the running build, nothing is claimed as
    /// current and the whole history reads as earlier builds.
    func presentation(info: [String: Any]?) -> WhatsNewPresentation {
        guard let runningBuild = Self.metadataValue("CFBundleVersion", info: info),
              let index = builds.firstIndex(where: { $0.build == runningBuild })
        else { return WhatsNewPresentation(current: nil, earlier: builds) }

        var earlier = builds
        let current = earlier.remove(at: index)
        return WhatsNewPresentation(current: current, earlier: earlier)
    }

    /// `0.1.0 (29)` for the running bundle, or `nil` when either value is
    /// missing or unexpanded.
    static func buildLabel(info: [String: Any]?) -> String? {
        guard let version = metadataValue("CFBundleShortVersionString", info: info),
              let build = metadataValue("CFBundleVersion", info: info)
        else { return nil }
        return "\(version) (\(build))"
    }

    /// Newest build number first. Builds without a numeric build number keep
    /// their payload order and sit after the numbered ones, so a malformed
    /// entry never reshuffles the real history.
    private static func ordered(_ builds: [Build]) -> [Build] {
        builds.enumerated()
            .sorted { lhs, rhs in
                switch (lhs.element.buildNumber, rhs.element.buildNumber) {
                case let (left?, right?) where left != right: left > right
                case (nil, .some): false
                case (.some, nil): true
                default: lhs.offset < rhs.offset
                }
            }
            .map(\.element)
    }

    private static func metadataValue(_ key: String, info: [String: Any]?) -> String? {
        guard let value = info?[key] as? String else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.hasPrefix("$(") else { return nil }
        return trimmed
    }

    private struct Payload: Decodable {
        let builds: [Build]?
        let entries: [Entry]?
    }
}

struct WhatsNewPresentation: Equatable, Sendable {
    let current: WhatsNewChangelog.Build?
    let earlier: [WhatsNewChangelog.Build]
}

extension WhatsNewChangelog.Build {
    /// Drops builds that say nothing once their entries are cleaned up, and
    /// treats a blank version or build as unrecorded.
    var normalized: WhatsNewChangelog.Build? {
        let entries = entries.compactMap(\.normalized)
        guard !entries.isEmpty else { return nil }
        return WhatsNewChangelog.Build(
            version: version?.trimmedOrNil,
            build: build?.trimmedOrNil,
            entries: entries
        )
    }
}

extension WhatsNewChangelog.Entry {
    /// Drops entries with no title and treats a blank summary as absent, so a
    /// sloppy payload degrades to fewer rows instead of empty ones.
    var normalized: WhatsNewChangelog.Entry? {
        guard let title = title.trimmedOrNil else { return nil }
        let images = (images ?? []).compactMap(\.normalized).prefix(Self.maximumImages)
        return WhatsNewChangelog.Entry(
            title: title,
            summary: summary?.trimmedOrNil,
            detail: detail?.trimmedOrNil,
            symbol: symbol?.trimmedOrNil,
            images: images.isEmpty ? nil : Array(images)
        )
    }

    /// A changelog entry is a release note, not a gallery; anything past this
    /// is dropped so a runaway payload cannot build an unbounded screen.
    static let maximumImages = 6
}

extension WhatsNewChangelog.Image {
    var normalized: WhatsNewChangelog.Image? {
        guard let name = name.trimmedOrNil else { return nil }
        return WhatsNewChangelog.Image(
            name: name,
            darkName: darkName?.trimmedOrNil,
            caption: caption?.trimmedOrNil
        )
    }
}

private extension String {
    var trimmedOrNil: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
