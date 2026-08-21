import Foundation
import Testing
@testable import T3Code

@Suite("Transcript message timestamps")
struct FeatureMessageTimestampTests {
    private let locale = Locale(identifier: "en_US_POSIX")
    private let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        calendar.locale = Locale(identifier: "en_US_POSIX")
        return calendar
    }()

    private func date(
        year: Int = 2026,
        month: Int = 8,
        day: Int = 18,
        hour: Int = 0,
        minute: Int = 0
    ) -> Date {
        calendar.date(
            from: DateComponents(
                timeZone: calendar.timeZone,
                year: year,
                month: month,
                day: day,
                hour: hour,
                minute: minute
            )
        )!
    }

    private func message(_ id: String, at createdAt: Date) -> FeatureMessage {
        FeatureMessage(id: id, role: .user, text: id, createdAt: createdAt)
    }

    private func labels(_ messages: [FeatureMessage], now: Date) -> [String: String] {
        FeatureMessageTimestamps.separatorLabels(
            for: messages,
            now: now,
            calendar: calendar,
            locale: locale
        )
    }

    /// The time as the app itself renders it, so structural assertions below
    /// stay honest without pinning ICU's exact clock formatting.
    private func time(_ instant: Date) -> String {
        instant.formatted(
            Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
                .hour()
                .minute()
        )
    }

    @Test
    func emptyTranscriptProducesNoSeparators() {
        #expect(labels([], now: date(hour: 12)).isEmpty)
    }

    @Test
    func firstMessageAlwaysOpensWithItsTime() {
        let sent = date(hour: 9, minute: 5)
        let result = labels([message("m1", at: sent)], now: date(hour: 12))

        #expect(result == ["m1": time(sent)])
    }

    @Test
    func messagesInsideTheQuietGapStayBare() {
        let first = date(hour: 9, minute: 0)
        let result = labels(
            [
                message("m1", at: first),
                message("m2", at: first.addingTimeInterval(60)),
                message("m3", at: first.addingTimeInterval(14 * 60 + 59)),
            ],
            now: date(hour: 12)
        )

        #expect(Set(result.keys) == ["m1"])
    }

    @Test
    func aQuietGapEarnsAFreshTime() {
        let first = date(hour: 9, minute: 0)
        let resumed = first.addingTimeInterval(40 * 60)
        let result = labels(
            [
                message("m1", at: first),
                message("m2", at: first.addingTimeInterval(30)),
                message("m3", at: resumed),
                message("m4", at: resumed.addingTimeInterval(30)),
            ],
            now: date(hour: 12)
        )

        #expect(Set(result.keys) == ["m1", "m3"])
        #expect(result["m3"] == time(resumed))
    }

    @Test
    func theGapBoundaryItselfCounts() {
        let first = date(hour: 9, minute: 0)
        let atBoundary = first.addingTimeInterval(FeatureMessageTimestamps.quietGap)
        let result = labels(
            [message("m1", at: first), message("m2", at: atBoundary)],
            now: date(hour: 12)
        )

        #expect(Set(result.keys) == ["m1", "m2"])
    }

    @Test
    func aNewDayEarnsATimeEvenSecondsApart() {
        let lateLastNight = date(day: 17, hour: 23, minute: 59)
        let justAfterMidnight = date(day: 18, hour: 0, minute: 0)
        let result = labels(
            [message("m1", at: lateLastNight), message("m2", at: justAfterMidnight)],
            now: date(hour: 12)
        )

        #expect(Set(result.keys) == ["m1", "m2"])
    }

    @Test
    func anOutOfOrderMessageDoesNotInventASeparator() {
        let first = date(hour: 9, minute: 30)
        let result = labels(
            [message("m1", at: first), message("m2", at: first.addingTimeInterval(-60))],
            now: date(hour: 12)
        )

        #expect(Set(result.keys) == ["m1"])
    }

    @Test
    func todayReadsAsAClockTimeAlone() {
        let sent = date(hour: 20, minute: 21)
        let label = FeatureMessageTimestamps.label(
            for: sent,
            now: date(hour: 22),
            calendar: calendar,
            locale: locale
        )

        #expect(label == time(sent))
    }

    @Test
    func yesterdayIsNamed() {
        let sent = date(day: 17, hour: 20, minute: 21)
        let label = FeatureMessageTimestamps.label(
            for: sent,
            now: date(day: 18, hour: 9),
            calendar: calendar,
            locale: locale
        )

        #expect(label == "Yesterday \(time(sent))")
    }

    @Test
    func earlierThisWeekCarriesTheWeekday() {
        // 2026-08-15 is a Saturday; three days before the 18th.
        let sent = date(day: 15, hour: 20, minute: 21)
        let label = FeatureMessageTimestamps.label(
            for: sent,
            now: date(day: 18, hour: 9),
            calendar: calendar,
            locale: locale
        )

        let weekday = sent.formatted(
            Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
                .weekday(.abbreviated)
        )
        #expect(label == "\(weekday) \(time(sent))")
        #expect(label.hasPrefix("Sat"))
    }

    @Test
    func olderThisYearCarriesTheDateWithoutTheYear() {
        let sent = date(month: 6, day: 2, hour: 20, minute: 21)
        let label = FeatureMessageTimestamps.label(
            for: sent,
            now: date(day: 18, hour: 9),
            calendar: calendar,
            locale: locale
        )

        #expect(label.hasPrefix("Jun 2"))
        #expect(label.hasSuffix(time(sent)))
        #expect(!label.contains("2026"))
    }

    @Test
    func anotherYearSaysSo() {
        let sent = date(year: 2025, month: 12, day: 30, hour: 20, minute: 21)
        let label = FeatureMessageTimestamps.label(
            for: sent,
            now: date(day: 18, hour: 9),
            calendar: calendar,
            locale: locale
        )

        #expect(label.hasPrefix("Dec 30"))
        #expect(label.contains("2025"))
        #expect(label.hasSuffix(time(sent)))
    }

    @Test
    func separatorsFollowTheSuppliedLocale() {
        let sent = date(hour: 20, minute: 21)
        let british = FeatureMessageTimestamps.label(
            for: sent,
            now: date(hour: 22),
            calendar: calendar,
            locale: Locale(identifier: "en_GB")
        )

        #expect(british.hasPrefix("20:21"))
    }

    @Test
    func separatorsFollowTheSuppliedTimeZone() {
        var pacific = calendar
        pacific.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        let sent = date(hour: 20, minute: 21)

        let label = FeatureMessageTimestamps.label(
            for: sent,
            now: date(hour: 22),
            calendar: pacific,
            locale: locale
        )

        // 20:21 UTC is 13:21 the same day in Los Angeles, so it stays time-only.
        #expect(label.hasPrefix("1:21"))
    }

    @Test
    func presentationContextChangesWithTheDay() {
        let beforeMidnight = FeatureMessageTimestamps.PresentationContext(
            now: date(day: 17, hour: 23, minute: 59),
            calendar: calendar,
            locale: locale
        )
        let afterMidnight = FeatureMessageTimestamps.PresentationContext(
            now: date(day: 18),
            calendar: calendar,
            locale: locale
        )

        #expect(beforeMidnight != afterMidnight)
    }

    @Test
    func presentationContextIsStableWithinTheDay() {
        let morning = FeatureMessageTimestamps.PresentationContext(
            now: date(hour: 8),
            calendar: calendar,
            locale: locale
        )
        let evening = FeatureMessageTimestamps.PresentationContext(
            now: date(hour: 20),
            calendar: calendar,
            locale: locale
        )

        #expect(morning == evening)
    }

    @Test
    func eachSeparatorBelongsToAMessageInTheTranscript() {
        let first = date(hour: 8)
        let messages = [
            message("m1", at: first),
            message("m2", at: first.addingTimeInterval(60)),
            message("m3", at: first.addingTimeInterval(3 * 3600)),
        ]
        let result = labels(messages, now: date(hour: 12))

        #expect(Set(result.keys).isSubset(of: Set(messages.map(\.id))))
        #expect(result.values.allSatisfy { !$0.isEmpty })
    }
}
