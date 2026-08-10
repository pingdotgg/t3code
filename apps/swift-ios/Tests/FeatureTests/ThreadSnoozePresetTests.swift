import Foundation
import Testing
@testable import T3Code

@Suite("Thread snooze presets")
struct ThreadSnoozePresetTests {
    private let locale = Locale(identifier: "en_US_POSIX")

    @Test
    func ordersTheUsefulCalendarPresetsAndOmitsDuplicateEveningBoundary() throws {
        let calendar = calendar(timeZone: TimeZone(secondsFromGMT: 0)!)
        let beforeBoundary = try date(
            year: 2026,
            month: 4,
            day: 8,
            hour: 16,
            minute: 59,
            calendar: calendar
        )
        let atBoundary = try date(
            year: 2026,
            month: 4,
            day: 8,
            hour: 17,
            calendar: calendar
        )

        let before = ThreadSnoozePresets.resolve(
            now: beforeBoundary,
            calendar: calendar,
            locale: locale
        )
        let at = ThreadSnoozePresets.resolve(
            now: atBoundary,
            calendar: calendar,
            locale: locale
        )

        #expect(before.map(\.id) == ["hour", "evening", "tomorrow", "next-week"])
        #expect(at.map(\.id) == ["hour", "tomorrow", "next-week"])
        #expect(before.allSatisfy { $0.until > beforeBoundary })
    }

    @Test
    func tomorrowUsesLocalCalendarTimeAcrossSpringDST() throws {
        let zone = try #require(TimeZone(identifier: "America/New_York"))
        let calendar = calendar(timeZone: zone)
        let now = try date(
            year: 2026,
            month: 3,
            day: 7,
            hour: 10,
            calendar: calendar
        )

        let tomorrow = try #require(ThreadSnoozePresets.resolve(
            now: now,
            calendar: calendar,
            locale: locale
        ).first { $0.id == "tomorrow" })
        let components = calendar.dateComponents([.year, .month, .day, .hour], from: tomorrow.until)

        #expect(components.year == 2026)
        #expect(components.month == 3)
        #expect(components.day == 8)
        #expect(components.hour == 9)
        #expect(tomorrow.until.timeIntervalSince(now) == 22 * 60 * 60)
    }

    @Test
    func nextWeekIsTheFollowingMondayEvenWhenTodayIsMonday() throws {
        let calendar = calendar(timeZone: TimeZone(secondsFromGMT: 0)!)
        let now = try date(
            year: 2026,
            month: 4,
            day: 6,
            hour: 10,
            calendar: calendar
        )

        let nextWeek = try #require(ThreadSnoozePresets.resolve(
            now: now,
            calendar: calendar,
            locale: locale
        ).first { $0.id == "next-week" })
        let components = calendar.dateComponents([.year, .month, .day, .hour], from: nextWeek.until)

        #expect(components.year == 2026)
        #expect(components.month == 4)
        #expect(components.day == 13)
        #expect(components.hour == 9)
        #expect(nextWeek.whenLabel.hasPrefix("Mon "))
    }

    @Test
    func nextWeekDoesNotDuplicateTomorrowOnSunday() throws {
        let calendar = calendar(timeZone: TimeZone(secondsFromGMT: 0)!)
        let now = try date(
            year: 2026,
            month: 4,
            day: 5,
            hour: 10,
            calendar: calendar
        )

        let presets = ThreadSnoozePresets.resolve(
            now: now,
            calendar: calendar,
            locale: locale
        )
        let tomorrow = try #require(presets.first { $0.id == "tomorrow" })
        let nextWeek = try #require(presets.first { $0.id == "next-week" })
        let components = calendar.dateComponents([.year, .month, .day, .hour], from: nextWeek.until)

        #expect(nextWeek.until != tomorrow.until)
        #expect(components.year == 2026)
        #expect(components.month == 4)
        #expect(components.day == 13)
        #expect(components.hour == 9)
    }

    @Test
    func settledThreadsKeepPresetsAndSnoozedThreadsKeepWake() throws {
        let calendar = calendar(timeZone: TimeZone(secondsFromGMT: 0)!)
        let now = try date(
            year: 2026,
            month: 4,
            day: 8,
            hour: 10,
            calendar: calendar
        )
        var thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            title: "Snooze",
            isSettled: true,
            supportsSnooze: true
        )

        let settled = ThreadSnoozeMenuModel.menu(
            for: thread,
            isArchived: false,
            now: now,
            calendar: calendar,
            locale: locale
        )
        guard case let .presets(presets, enabled) = settled else {
            Issue.record("Settled thread should offer snooze presets")
            return
        }
        #expect(presets.map(\.id) == ["hour", "evening", "tomorrow", "next-week"])
        #expect(enabled)

        thread.snoozedUntil = now.addingTimeInterval(60 * 60)
        #expect(ThreadSnoozeMenuModel.menu(
            for: thread,
            isArchived: false,
            now: now,
            calendar: calendar,
            locale: locale
        ) == .unsnooze)
        #expect(ThreadSnoozeMenuModel.menu(
            for: thread,
            isArchived: true,
            now: now,
            calendar: calendar,
            locale: locale
        ) == .hidden)
    }

    @Test
    func pendingThreadsKeepThePresetOrderButDisableEveryChoice() throws {
        let calendar = calendar(timeZone: TimeZone(secondsFromGMT: 0)!)
        let now = try date(
            year: 2026,
            month: 4,
            day: 8,
            hour: 10,
            calendar: calendar
        )
        let thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            title: "Pending",
            state: .waitingForApproval,
            supportsSnooze: true
        )

        let menu = ThreadSnoozeMenuModel.menu(
            for: thread,
            isArchived: false,
            now: now,
            calendar: calendar,
            locale: locale
        )
        guard case let .presets(presets, enabled) = menu else {
            Issue.record("Pending thread should keep a disabled Snooze menu")
            return
        }

        #expect(presets.map(\.id) == ["hour", "evening", "tomorrow", "next-week"])
        #expect(!enabled)
    }

    @Test
    func capabilityAndQueuedGraceGateOnlyNewSnoozes() throws {
        let calendar = calendar(timeZone: TimeZone(secondsFromGMT: 0)!)
        let now = try date(
            year: 2026,
            month: 4,
            day: 8,
            hour: 10,
            calendar: calendar
        )
        var thread = FeatureThread(
            id: "thread-1",
            projectID: "project-1",
            title: "Capability",
            state: .queued,
            lastActivityAt: now.addingTimeInterval(-30),
            supportsSnooze: false
        )

        #expect(!thread.canStartSnooze(at: now))
        thread.supportsSnooze = true
        #expect(!thread.canStartSnooze(at: now))
        thread.lastActivityAt = now.addingTimeInterval(3 * 60)
        #expect(!thread.canStartSnooze(at: now))
        thread.lastActivityAt = now.addingTimeInterval(-3 * 60)
        #expect(thread.canStartSnooze(at: now))

        thread.state = .waitingForApproval
        thread.snoozedUntil = now.addingTimeInterval(60 * 60)
        #expect(ThreadSnoozeMenuModel.menu(
            for: thread,
            isArchived: false,
            now: now,
            calendar: calendar,
            locale: locale
        ) == .unsnooze)
    }

    private func calendar(timeZone: TimeZone) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar
    }

    private func date(
        year: Int,
        month: Int,
        day: Int,
        hour: Int,
        minute: Int = 0,
        calendar: Calendar
    ) throws -> Date {
        try #require(calendar.date(from: DateComponents(
            year: year,
            month: month,
            day: day,
            hour: hour,
            minute: minute
        )))
    }
}
