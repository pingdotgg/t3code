import Foundation

struct ThreadSnoozePreset: Identifiable, Equatable, Sendable {
    let id: String
    let label: String
    let whenLabel: String
    let until: Date

    var menuTitle: String {
        "\(label) (\(whenLabel))"
    }
}

enum ThreadSnoozeMenu: Equatable, Sendable {
    case hidden
    case unsnooze
    case presets([ThreadSnoozePreset], enabled: Bool)
}

enum ThreadSnoozeMenuModel {
    static func menu(
        for thread: FeatureThread,
        isArchived: Bool,
        now: Date = .now,
        calendar: Calendar = .current,
        locale: Locale = .current
    ) -> ThreadSnoozeMenu {
        guard !isArchived, thread.canToggleSnooze else { return .hidden }
        if thread.snoozedUntil.map({ $0 > now }) == true {
            return .unsnooze
        }
        return .presets(
            ThreadSnoozePresets.resolve(now: now, calendar: calendar, locale: locale),
            enabled: thread.canStartSnooze(at: now)
        )
    }
}

enum ThreadSnoozePresets {
    private static let eveningHour = 18
    private static let morningHour = 9

    static func resolve(
        now: Date = .now,
        calendar: Calendar = .current,
        locale: Locale = .current
    ) -> [ThreadSnoozePreset] {
        let inAnHour = now.addingTimeInterval(60 * 60)
        var presets = [preset(
            id: "hour",
            label: "In 1 hour",
            until: inAnHour,
            calendar: calendar,
            locale: locale
        )]

        if let evening = localTime(eveningHour, on: now, calendar: calendar),
           evening > inAnHour {
            presets.append(preset(
                id: "evening",
                label: "This evening",
                until: evening,
                calendar: calendar,
                locale: locale
            ))
        }

        if let tomorrowDay = calendar.date(byAdding: .day, value: 1, to: now),
           let tomorrow = localTime(morningHour, on: tomorrowDay, calendar: calendar),
           tomorrow > now {
            presets.append(preset(
                id: "tomorrow",
                label: "Tomorrow",
                until: tomorrow,
                calendar: calendar,
                locale: locale
            ))
        }

        let weekday = calendar.component(.weekday, from: now)
        let daysUntilMonday = switch weekday {
        case 1: 8
        case 2: 7
        default: (2 - weekday + 7) % 7
        }
        if let mondayDay = calendar.date(byAdding: .day, value: daysUntilMonday, to: now),
           let nextWeek = localTime(morningHour, on: mondayDay, calendar: calendar),
           nextWeek > now {
            presets.append(preset(
                id: "next-week",
                label: "Next week",
                until: nextWeek,
                calendar: calendar,
                locale: locale,
                whenPrefix: weekdayLabel(nextWeek, calendar: calendar, locale: locale)
            ))
        }

        return presets
    }

    private static func preset(
        id: String,
        label: String,
        until: Date,
        calendar: Calendar,
        locale: Locale,
        whenPrefix: String? = nil
    ) -> ThreadSnoozePreset {
        let time = timeLabel(until, calendar: calendar, locale: locale)
        return ThreadSnoozePreset(
            id: id,
            label: label,
            whenLabel: [whenPrefix, time].compactMap { $0 }.joined(separator: " "),
            until: until
        )
    }

    private static func localTime(_ hour: Int, on day: Date, calendar: Calendar) -> Date? {
        calendar.date(bySettingHour: hour, minute: 0, second: 0, of: day)
    }

    private static func timeLabel(
        _ date: Date,
        calendar: Calendar,
        locale: Locale
    ) -> String {
        var style = Date.FormatStyle(date: .omitted, time: .shortened)
        style.locale = locale
        style.calendar = calendar
        style.timeZone = calendar.timeZone
        return date.formatted(style)
    }

    private static func weekdayLabel(
        _ date: Date,
        calendar: Calendar,
        locale: Locale
    ) -> String {
        var style = Date.FormatStyle().weekday(.abbreviated)
        style.locale = locale
        style.calendar = calendar
        style.timeZone = calendar.timeZone
        return date.formatted(style)
    }
}

extension FeatureThread {
    func canStartSnooze(at now: Date) -> Bool {
        guard supportsSnooze != false,
              state != .waitingForApproval,
              state != .waitingForInput else {
            return false
        }
        guard state == .queued, let lastActivityAt else { return true }
        return now.timeIntervalSince(lastActivityAt) > 2 * 60
    }
}
