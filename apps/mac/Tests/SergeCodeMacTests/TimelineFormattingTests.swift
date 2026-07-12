import Foundation
import Testing

@testable import SergeCodeMac

private func testCalendar() -> Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.locale = Locale(identifier: "en_US_POSIX")
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    return calendar
}

private func testDate(
    _ year: Int,
    _ month: Int,
    _ day: Int,
    _ hour: Int = 0,
    _ minute: Int = 0,
    calendar: Calendar
) -> Date {
    calendar.date(
        from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute))!
}

@Suite("Timeline separator formatting")
@MainActor
struct TimelineSeparatorFormattingTests {
    @Test("labels today, yesterday, nearby weekdays, and older dates")
    func separatorLabels() {
        let calendar = testCalendar()
        let now = testDate(2026, 7, 10, 12, calendar: calendar)

        #expect(separatorLabel(for: now, relativeTo: now, calendar: calendar) == "Today")
        #expect(
            separatorLabel(
                for: testDate(2026, 7, 9, 12, calendar: calendar),
                relativeTo: now,
                calendar: calendar) == "Yesterday")
        #expect(
            separatorLabel(
                for: testDate(2026, 7, 8, 12, calendar: calendar),
                relativeTo: now,
                calendar: calendar) == "Wednesday")
        #expect(
            separatorLabel(
                for: testDate(2026, 7, 3, 12, calendar: calendar),
                relativeTo: now,
                calendar: calendar) == "Jul 3")
    }

    @Test("emits a stable separator for a same-day pause")
    func sameDayGapEmitsTimeSeparator() {
        let calendar = testCalendar()
        let now = testDate(2026, 7, 10, 12, calendar: calendar)
        let firstAt = testDate(2026, 7, 10, 8, 0, calendar: calendar)
        let secondAt = testDate(2026, 7, 10, 9, 30, calendar: calendar)
        let items: [TimelineItem] = [
            .userMessage(id: "first", text: "Earlier", at: firstAt),
            .assistantMessage(
                id: "second", markdown: "Later", isStreaming: false, at: secondAt),
        ]

        let display = items.groupedForDisplay(now: now, calendar: calendar)

        #expect(display.count == 3)
        guard case .daySeparator(let id, let label) = display[1] else {
            Issue.record("Expected a same-day separator before the second item")
            return
        }
        #expect(id == "sep-second")
        #expect(label == "9:30\u{202F}AM")
    }

    @Test("emits a day separator when the calendar day changes")
    func dayChangeEmitsRelativeLabel() {
        let calendar = testCalendar()
        let now = testDate(2026, 7, 10, 12, calendar: calendar)
        let items: [TimelineItem] = [
            .userMessage(
                id: "yesterday", text: "Yesterday", at: testDate(
                    2026, 7, 9, 23, 30, calendar: calendar)),
            .assistantMessage(
                id: "today", markdown: "Today", isStreaming: false, at: testDate(
                    2026, 7, 10, 0, 15, calendar: calendar)),
        ]

        let display = items.groupedForDisplay(now: now, calendar: calendar)

        #expect(display.count == 3)
        guard case .daySeparator(let id, let label) = display[1] else {
            Issue.record("Expected a calendar-day separator before today's item")
            return
        }
        #expect(id == "sep-today")
        #expect(label == "Today")
    }

    @Test("exposes event times on timeline and display items")
    func timelineTimeAccessors() {
        let calendar = testCalendar()
        let at = testDate(2026, 7, 10, 9, calendar: calendar)
        let item = TimelineItem.userMessage(id: "message", text: "Hello", at: at)
        let display = TimelineDisplayItem.single(item)

        #expect(item.at == at)
        #expect(display.at == at)
        #expect(TimelineDisplayItem.daySeparator(id: "separator", label: "Today").at == nil)
    }
}

@Suite("Transcript timestamp formatting")
@MainActor
struct TranscriptTimestampFormattingTests {
    @Test("uses time for same-day dates and month-day for older dates")
    func sameDayAndOlderFormats() {
        let calendar = testCalendar()
        let now = testDate(2026, 7, 10, 14, 47, calendar: calendar)
        let sameDay = testDate(2026, 7, 10, 13, 5, calendar: calendar)
        let older = testDate(2026, 7, 4, 13, 5, calendar: calendar)

        #expect(
            TranscriptTimestamp.text(
                for: sameDay, relativeTo: now, calendar: calendar) == "1:05\u{202F}PM")
        #expect(
            TranscriptTimestamp.text(
                for: older, relativeTo: now, calendar: calendar) == "Jul 4 at 1:05\u{202F}PM")
    }
}
