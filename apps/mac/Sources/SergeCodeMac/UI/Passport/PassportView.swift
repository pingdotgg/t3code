import SwiftUI

/// The display-ready shape of one passport page. It keeps the view layer
/// free of set/stamp matching rules and makes the collection math testable.
@MainActor
struct PassportPageDisplay {
    let page: PassportPage
    let scenerySet: ScenerySet?
    let places: [PassportPlaceDisplay]
    let collectedCount: Int
    let totalCount: Int

    var id: String { page.setId }

    var progress: Double {
        guard totalCount > 0 else { return 0 }
        return min(1, Double(collectedCount) / Double(totalCount))
    }

    init(page: PassportPage, scenerySet: ScenerySet?) {
        self.page = page
        self.scenerySet = scenerySet

        var names: [(key: String, name: String)] = []
        var knownKeys = Set<String>()
        let sourceNames = (scenerySet?.sceneNames ?? []) + page.stamps.map(\.placeName)
        for rawName in sourceNames {
            let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
            let key = Self.comparisonKey(name)
            guard !key.isEmpty, knownKeys.insert(key).inserted else { continue }
            names.append((key: key, name: name))
        }

        var stampsByKey: [String: PassportStamp] = [:]
        for stamp in page.stamps {
            let key = Self.comparisonKey(stamp.placeName)
            guard !key.isEmpty, stampsByKey[key] == nil else { continue }
            stampsByKey[key] = stamp
        }

        places = names.map { item in
            PassportPlaceDisplay(
                id: item.key,
                name: item.name,
                stamp: stampsByKey[item.key])
        }
        // PassportStore maintains one stamp per place. Keep this count tied to
        // the persisted ledger so the header and progress label reflect the
        // actual collected stamp count, including legacy data.
        collectedCount = page.stamps.count
        totalCount = places.count
    }

    /// Default set first when the setting resolves to a loaded manifest;
    /// otherwise pages retain their chronological issue order.
    static func orderedPages(
        pages: [PassportPage],
        scenerySets: [ScenerySet],
        defaultSetId: String?
    ) -> [PassportPage] {
        let resolvedDefault = defaultSetId.flatMap { defaultID in
            scenerySets.contains(where: { $0.id == defaultID }) ? defaultID : nil
        }

        return pages.sorted { lhs, rhs in
            let lhsIsDefault = resolvedDefault.map { lhs.setId == $0 } ?? false
            let rhsIsDefault = resolvedDefault.map { rhs.setId == $0 } ?? false
            if lhsIsDefault != rhsIsDefault { return lhsIsDefault }
            if lhs.issuedAt != rhs.issuedAt { return lhs.issuedAt < rhs.issuedAt }
            return lhs.setId.localizedCaseInsensitiveCompare(rhs.setId) == .orderedAscending
        }
    }

    private static func comparisonKey(_ value: String) -> String {
        PassportStamp.placeSlug(for: value)
    }
}

@MainActor
struct PassportPlaceDisplay {
    let id: String
    let name: String
    let stamp: PassportStamp?

    var isVisited: Bool { stamp != nil }
}

@MainActor
struct PassportView: View {
    let scenery: SceneryStore
    let passport: PassportStore
    @Binding var isPresented: Bool

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()

            if isEmptyPassport {
                ContentUnavailableView(
                    "No stamps yet",
                    systemImage: "book.closed",
                    description: Text("Start a new session to visit your first place."))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 28) {
                        ForEach(pageDisplays, id: \.id) { display in
                            PassportPageSection(display: display, scenery: scenery)
                        }
                    }
                    .padding(24)
                }
                .background { Rectangle().fill(.background) }
            }
        }
        .background { Rectangle().fill(.background) }
        .frame(minWidth: 600, idealWidth: 640, minHeight: 520, idealHeight: 560)
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 16) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Passport")
                    .font(.title.bold())
                Text(collectedSummary)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            Button("Done") {
                isPresented = false
            }
            .buttonStyle(.glass)
            .keyboardShortcut(.cancelAction)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
        .glassEffect(.regular, in: .rect(cornerRadius: AlpineTheme.Corners.hero))
        .padding(8)
    }

    private var pageDisplays: [PassportPageDisplay] {
        PassportPageDisplay.orderedPages(
            pages: passport.pages,
            scenerySets: scenery.availableSets,
            defaultSetId: scenery.defaultSetId)
            .map { page in
                PassportPageDisplay(page: page, scenerySet: scenery.set(id: page.setId))
            }
    }

    private var isEmptyPassport: Bool {
        passport.pages.isEmpty
    }

    private var collectedSummary: String {
        let count = passport.pages.reduce(0) { $0 + $1.stamps.count }
        return "\(count) \(count == 1 ? "place" : "places") collected"
    }
}

@MainActor
private struct PassportPageSection: View {
    let display: PassportPageDisplay
    let scenery: SceneryStore

    private var accent: Color {
        AlpineTheme.accent(palette: display.scenerySet?.palette)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .bottom, spacing: 16) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(display.page.title)
                        .font(.title3.bold())
                    Text("Issued \(display.page.issuedAt.formatted(date: .abbreviated, time: .omitted))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer(minLength: 8)

                VStack(alignment: .trailing, spacing: 5) {
                    Text("\(display.collectedCount) of \(display.totalCount) places")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                    ProgressView(value: display.progress)
                        .tint(accent)
                        .frame(width: 120)
                }
            }

            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 150), spacing: 12)],
                spacing: 12)
            {
                ForEach(display.places, id: \.id) { place in
                    PassportPlaceCell(
                        place: place,
                        scenery: scenery,
                        setId: display.page.setId,
                        accent: accent)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(
            "\(display.page.title), \(display.collectedCount) of \(display.totalCount) places collected")
    }
}

@MainActor
private struct PassportPlaceCell: View {
    let place: PassportPlaceDisplay
    let scenery: SceneryStore
    let setId: String
    let accent: Color

    var body: some View {
        Group {
            if let stamp = place.stamp {
                visitedCell(stamp)
            } else {
                unvisitedCell
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
    }

    private func visitedCell(_ stamp: PassportStamp) -> some View {
        let photo = stamp.photoID.flatMap { scenery.photo(for: $0, inSet: setId) }

        return ZStack(alignment: .bottomLeading) {
            SceneryImageView(
                scenery: scenery,
                photo: photo,
                variant: .thumb,
                setId: setId,
                fallbackSeed: stamp.id)
                .overlay { Color.black.opacity(0.22) }

            VStack(alignment: .leading, spacing: 2) {
                Text(place.name)
                    .font(.system(.headline, design: .serif).weight(.semibold))
                    .foregroundStyle(.white)
                    .lineLimit(2)
                    .shadow(color: .black.opacity(0.45), radius: 2, y: 1)
                Text("Visited \(stamp.firstVisitedAt.formatted(date: .abbreviated, time: .omitted))")
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.88))
                    .lineLimit(1)
            }
            .padding(12)

            if stamp.visitCount > 1 {
                Text("×\(stamp.visitCount)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 4)
                    .background(Color.black.opacity(0.46), in: Capsule())
                    .padding(9)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
            }
        }
        .frame(maxWidth: .infinity)
        .aspectRatio(1.22, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .stroke(accent.opacity(0.9), lineWidth: 1.5)
        }
        .rotationEffect(rotation(for: stamp))
    }

    private var unvisitedCell: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .fill(accent.opacity(0.035))
            VStack(spacing: 8) {
                Image(systemName: "circle.dashed")
                    .font(.title3)
                    .foregroundStyle(.tertiary)
                Text(place.name)
                    .font(.system(.headline, design: .rounded))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .lineLimit(3)
            }
            .padding(12)
        }
        .frame(maxWidth: .infinity)
        .aspectRatio(1.22, contentMode: .fit)
        .overlay {
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .stroke(
                    accent.opacity(0.38),
                    style: StrokeStyle(lineWidth: 1.2, dash: [6, 5]))
        }
    }

    private var accessibilityLabel: String {
        guard let stamp = place.stamp else {
            return "\(place.name), not yet visited"
        }
        let visits = stamp.visitCount == 1 ? "visit" : "visits"
        return "\(place.name), visited \(stamp.firstVisitedAt.formatted(date: .long, time: .omitted)), \(stamp.visitCount) \(visits)"
    }

    private func rotation(for stamp: PassportStamp) -> Angle {
        let bucket = AlpineTheme.stableIndex(stamp.id, 1_001)
        let degrees = (Double(bucket) / 1_000) * 5 - 2.5
        return .degrees(degrees)
    }
}
