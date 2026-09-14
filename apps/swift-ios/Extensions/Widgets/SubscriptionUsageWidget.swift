import AppIntents
import SwiftUI
import WidgetKit

enum T3SubscriptionPeriod: String, AppEnum {
    case both
    case session
    case weekly

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Period"
    static var caseDisplayRepresentations: [T3SubscriptionPeriod: DisplayRepresentation] = [
        .both: "Both", .session: "Session", .weekly: "Weekly",
    ]
}

struct T3SubscriptionUsageConfiguration: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Subscription usage"
    static var description = IntentDescription("Choose the limits shown for each provider.")

    @Parameter(title: "Codex", default: .both)
    var codexPeriod: T3SubscriptionPeriod

    @Parameter(title: "Claude", default: .both)
    var claudePeriod: T3SubscriptionPeriod
}

private struct T3SubscriptionUsageEntry: TimelineEntry {
    let date: Date
    let snapshot: T3SubscriptionUsageSnapshot
    let configuration: T3SubscriptionUsageConfiguration
}

private struct T3SubscriptionUsageProvider: AppIntentTimelineProvider {
    func placeholder(in _: Context) -> T3SubscriptionUsageEntry {
        .init(date: Date(), snapshot: .empty, configuration: .init())
    }

    func snapshot(for configuration: T3SubscriptionUsageConfiguration, in _: Context) async -> T3SubscriptionUsageEntry {
        .init(date: Date(), snapshot: T3SubscriptionUsageSnapshotStore.load(), configuration: configuration)
    }

    func timeline(for configuration: T3SubscriptionUsageConfiguration, in _: Context) async -> Timeline<T3SubscriptionUsageEntry> {
        let snapshot = T3SubscriptionUsageSnapshotStore.load()
        let entries = snapshot.timelineDates(from: Date()).map {
            T3SubscriptionUsageEntry(date: $0, snapshot: snapshot, configuration: configuration)
        }
        return Timeline(entries: entries, policy: .never)
    }
}

struct T3SubscriptionUsageWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: T3SubscriptionUsageSnapshotStore.kind,
            intent: T3SubscriptionUsageConfiguration.self,
            provider: T3SubscriptionUsageProvider()
        ) { entry in
            T3SubscriptionUsageView(entry: entry)
                .containerBackground(.black, for: .widget)
        }
        .configurationDisplayName("Subscription usage")
        .description("Pooled Codex and Claude limits. Open T3 to refresh.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .systemExtraLarge, .accessoryRectangular])
    }
}

private struct T3SubscriptionUsageView: View {
    @Environment(\.widgetFamily) private var family
    let entry: T3SubscriptionUsageEntry

    private var accessory: Bool { family == .accessoryRectangular }
    private var compact: Bool { family == .systemSmall || accessory }
    private var dense: Bool { family == .systemSmall || family == .systemMedium }
    private var limit: Int { family == .systemExtraLarge ? 6 : family == .systemLarge ? 4 : 2 }
    // Widget galleries can request an old entry after its expiry.
    private var now: Date { max(entry.date, Date()) }

    var body: some View {
        VStack(alignment: .leading, spacing: dense || accessory ? 2 : 6) {
            if compact {
                VStack(alignment: .leading, spacing: 4) {
                    columns
                }
            } else {
                HStack(alignment: .top, spacing: 16) {
                    columns
                }
            }
            if !accessory {
                Spacer(minLength: 0)
                Text(entry.snapshot.checkedAt.map {
                    "As of \($0.formatted(date: .abbreviated, time: .shortened))"
                } ?? "Tap to connect in T3")
                    .font(.system(size: 10))
                    .foregroundStyle(.white.opacity(0.65))
                    .lineLimit(1)
            }
        }
        .foregroundStyle(.white)
        .widgetURL(URL(string: "\(T3SharedContainer.urlScheme)://usage/limits"))
    }

    @ViewBuilder
    private var columns: some View {
        ForEach(entry.snapshot.providers) { provider in
            providerColumn(provider)
        }
    }

    private func providerColumn(_ provider: T3SubscriptionUsageSnapshot.Provider) -> some View {
        let period = provider.id == "codex" ? entry.configuration.codexPeriod : entry.configuration.claudePeriod
        let shown = provider.visibleWindows(period: period.rawValue, limit: limit, at: now, tightestOnly: accessory)
        let missingPeriod = period != .both && shown.isEmpty && provider.isFresh(at: now) && !provider.windows.isEmpty
        let detail = missingPeriod ? "No \(period.rawValue) limit reported" : provider.detail(at: now)
        return VStack(alignment: .leading, spacing: dense ? 1 : 4) {
            HStack(spacing: 4) {
                Text(provider.name)
                    .font(.system(size: compact ? 12 : 15, weight: .bold))
                    .lineLimit(1)
                if accessory {
                    Spacer(minLength: 4)
                    Text(shown.first.map { "\($0.remaining)% left" } ?? (missingPeriod ? "N/A" : "Open T3"))
                        .font(.system(size: 12, weight: .semibold))
                        .lineLimit(1)
                }
            }
            if !accessory && (!compact || shown.isEmpty || provider.hasPartialData) {
                // Both columns reserve the same detail line. Quota count must
                // not change text sizes, bar heights, or first-row alignment.
                Text(detail == "Subscription remaining" ? " " : detail)
                    .font(.system(size: 10))
                    .foregroundStyle(.white.opacity(0.65))
                    .lineLimit(1)
                    .frame(height: 12, alignment: .leading)
            }
            ForEach(shown) { window in
                VStack(alignment: .leading, spacing: dense ? 1 : 2) {
                    if !accessory {
                        HStack(spacing: 4) {
                            Text(window.label)
                                .lineLimit(1)
                            Spacer(minLength: 2)
                            Text("\(window.remaining)% left")
                                .fontWeight(.semibold)
                                .monospacedDigit()
                                .lineLimit(1)
                                .layoutPriority(1)
                        }
                        .font(.system(size: compact || dense ? 11 : 12))
                    }
                    GeometryReader { geometry in
                        ZStack(alignment: .leading) {
                            Rectangle().fill(.white.opacity(0.18))
                            Rectangle().fill(.white)
                                .frame(width: geometry.size.width * Double(min(100, max(0, window.remaining))) / 100)
                        }
                    }
                    .frame(height: 4)
                    if !compact {
                        Text(window.resetAt.map {
                            "Next reset \($0.formatted(date: .abbreviated, time: .shortened))"
                        } ?? "Reset time unavailable")
                            .font(.system(size: 10))
                            .foregroundStyle(.white.opacity(0.65))
                            .lineLimit(1)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(provider.name), \(window.label), \(window.remaining) percent remaining. \(detail).")
            }
            let total = period == .both ? provider.totalWindows : provider.windows.filter { $0.kind == period.rawValue }.count
            if !compact, provider.isFresh(at: now), total > shown.count {
                Text("\(total - shown.count) more in T3")
                    .font(.system(size: 10))
                    .foregroundStyle(.white.opacity(0.65))
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
    }
}
