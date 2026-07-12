import Foundation
import Observation

public struct PassportStamp: Codable, Hashable, Identifiable {
    public let id: String
    public var placeName: String
    public var photoID: String?
    public let firstVisitedAt: Date
    public var lastVisitedAt: Date
    public var visitCount: Int

    public init(
        id: String? = nil,
        placeName: String,
        photoID: String? = nil,
        firstVisitedAt: Date,
        lastVisitedAt: Date,
        visitCount: Int = 1
    ) {
        self.id = id ?? Self.placeSlug(for: placeName)
        self.placeName = placeName
        self.photoID = photoID
        self.firstVisitedAt = firstVisitedAt
        self.lastVisitedAt = lastVisitedAt
        self.visitCount = visitCount
    }

    static func placeSlug(for placeName: String) -> String {
        let normalized = placeName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        var components: [String] = []
        var component = ""
        for scalar in normalized.unicodeScalars {
            if CharacterSet.alphanumerics.contains(scalar) {
                component.unicodeScalars.append(scalar)
            } else if !component.isEmpty {
                components.append(component)
                component = ""
            }
        }
        if !component.isEmpty {
            components.append(component)
        }
        return components.isEmpty ? normalized : components.joined(separator: "-")
    }
}

public struct PassportPage: Codable, Hashable {
    public let setId: String
    public var title: String
    public let issuedAt: Date
    public var stamps: [PassportStamp]

    public init(
        setId: String,
        title: String,
        issuedAt: Date,
        stamps: [PassportStamp] = []
    ) {
        self.setId = setId
        self.title = title
        self.issuedAt = issuedAt
        self.stamps = stamps.sorted { $0.firstVisitedAt < $1.firstVisitedAt }
    }
}

public struct PassportFile: Codable {
    public var version: Int = 1
    public var pages: [PassportPage]
    public var stampedThreadIDs: Set<String>

    public init(
        version: Int = 1,
        pages: [PassportPage] = [],
        stampedThreadIDs: Set<String> = []
    ) {
        self.version = version
        self.pages = pages
        self.stampedThreadIDs = stampedThreadIDs
    }
}

@MainActor
@Observable
public final class PassportStore {
    public private(set) var pages: [PassportPage]
    public private(set) var stampedThreadIDs: Set<String>

    private let root: URL
    private let fileURL: URL
    private var saveBlocked = false

    public init(rootOverride: URL? = nil) {
        if let rootOverride {
            root = rootOverride
        } else {
            let support =
                FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)
                .first ?? FileManager.default.temporaryDirectory
            root = support.appendingPathComponent("SergeCode/scenery", isDirectory: true)
        }
        fileURL = root.appendingPathComponent("passport.json")
        pages = []
        stampedThreadIDs = []
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        load()
    }

    public func ensurePage(setId: String, title: String, issuedAt: Date) {
        if let index = pages.firstIndex(where: { $0.setId == setId }) {
            guard pages[index].title != title else { return }
            pages[index].title = title
            save()
            return
        }

        pages.append(PassportPage(setId: setId, title: title, issuedAt: issuedAt))
        save()
    }

    public func recordVisit(
        threadID: String,
        setId: String,
        placeName: String,
        photoID: String?,
        date: Date
    ) {
        guard !stampedThreadIDs.contains(threadID) else { return }

        if pages.firstIndex(where: { $0.setId == setId }) == nil {
            ensurePage(setId: setId, title: setId, issuedAt: date)
        }
        guard let pageIndex = pages.firstIndex(where: { $0.setId == setId }) else { return }

        let trimmedName = placeName.trimmingCharacters(in: .whitespacesAndNewlines)
        let nameKey = Self.comparisonKey(trimmedName)
        let titleKey = Self.comparisonKey(pages[pageIndex].title)
        if !trimmedName.isEmpty, nameKey != titleKey {
            if let stampIndex = pages[pageIndex].stamps.firstIndex(where: {
                Self.comparisonKey($0.placeName) == nameKey
            }) {
                pages[pageIndex].stamps[stampIndex].visitCount += 1
                pages[pageIndex].stamps[stampIndex].lastVisitedAt = date
                if pages[pageIndex].stamps[stampIndex].photoID == nil {
                    pages[pageIndex].stamps[stampIndex].photoID = photoID
                }
            } else {
                pages[pageIndex].stamps.append(
                    PassportStamp(
                        placeName: trimmedName,
                        photoID: photoID,
                        firstVisitedAt: date,
                        lastVisitedAt: date))
                pages[pageIndex].stamps.sort { $0.firstVisitedAt < $1.firstVisitedAt }
            }
        }

        stampedThreadIDs.insert(threadID)
        save()
    }

    public func backfill(
        sets: [ScenerySet],
        namesBySet: [String: [String: String]],
        assignments: [String: SceneryAssignment],
        now: Date = Date()
    ) {
        for set in sets {
            let issuedAt =
                set.createdAt.timeIntervalSince1970 == 0
                ? now
                : set.createdAt
            ensurePage(setId: set.id, title: set.title, issuedAt: issuedAt)
        }

        for setId in namesBySet.keys.sorted() {
            for (threadID, placeName) in (namesBySet[setId] ?? [:]).sorted(by: {
                $0.key < $1.key
            }) {
                guard !stampedThreadIDs.contains(threadID) else { continue }
                let assignment = assignments[threadID]
                let resolvedSetId = assignment?.resolvedSetId ?? setId
                recordVisit(
                    threadID: threadID,
                    setId: resolvedSetId,
                    placeName: placeName,
                    photoID: assignment?.photoID,
                    date: now)
            }
        }
    }

    private func load() {
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            pages = []
            stampedThreadIDs = []
            return
        }

        do {
            let data = try Data(contentsOf: fileURL)
            let file = try JSONDecoder().decode(PassportFile.self, from: data)
            guard file.version == 1 else {
                blockSaving(reason: "unsupported version \(file.version)")
                return
            }
            pages = file.pages.map { page in
                var normalized = page
                normalized.stamps = Self.repairCollidingStamps(page.stamps)
                return normalized
            }
            stampedThreadIDs = file.stampedThreadIDs
        } catch {
            blockSaving(reason: "unreadable passport file")
        }
    }

    private func save() {
        guard !saveBlocked else { return }
        let file = PassportFile(pages: pages, stampedThreadIDs: stampedThreadIDs)
        guard let data = try? JSONEncoder().encode(file) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }

    private static func comparisonKey(_ value: String) -> String {
        PassportStamp.placeSlug(for: value)
    }

    private static func repairCollidingStamps(_ stamps: [PassportStamp]) -> [PassportStamp] {
        var mergedByKey: [String: PassportStamp] = [:]
        var keyOrder: [String] = []

        for stamp in stamps {
            let key = comparisonKey(stamp.placeName)
            if let existing = mergedByKey[key] {
                let earlierStamp =
                    existing.firstVisitedAt <= stamp.firstVisitedAt ? existing : stamp
                mergedByKey[key] = PassportStamp(
                    placeName: earlierStamp.placeName,
                    photoID: existing.photoID ?? stamp.photoID,
                    firstVisitedAt: min(existing.firstVisitedAt, stamp.firstVisitedAt),
                    lastVisitedAt: max(existing.lastVisitedAt, stamp.lastVisitedAt),
                    visitCount: existing.visitCount + stamp.visitCount)
            } else {
                mergedByKey[key] = PassportStamp(
                    placeName: stamp.placeName,
                    photoID: stamp.photoID,
                    firstVisitedAt: stamp.firstVisitedAt,
                    lastVisitedAt: stamp.lastVisitedAt,
                    visitCount: stamp.visitCount)
                keyOrder.append(key)
            }
        }

        return keyOrder.compactMap { mergedByKey[$0] }
            .sorted { $0.firstVisitedAt < $1.firstVisitedAt }
    }

    private func blockSaving(reason: String) {
        pages = []
        stampedThreadIDs = []
        saveBlocked = true
        print("PassportStore: \(reason); preserving \(fileURL.path)")
    }
}
