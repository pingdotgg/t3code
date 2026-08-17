import Foundation

/// Decides which transcript messages show their time, and how that time reads.
///
/// Stamping every message would bury the conversation, so a message only earns a
/// separator when the reader has actually lost their place: it opens the
/// transcript, it starts a new day, or it follows a quiet gap.
enum FeatureMessageTimestamps {
    /// A pause long enough that "when did this happen" stops being obvious from
    /// the message above.
    static let quietGap: TimeInterval = 15 * 60

    /// Message ID to separator label, for the messages that earn one. Messages
    /// without a separator are absent from the result.
    static func separatorLabels(
        for messages: [FeatureMessage],
        now: Date = .now,
        calendar: Calendar = .current,
        locale: Locale = .current
    ) -> [String: String] {
        var labels: [String: String] = [:]
        var previous: Date?
        for message in messages {
            let createdAt = message.createdAt
            defer { previous = createdAt }
            if let previous, !opensSeparator(createdAt, after: previous, calendar: calendar) {
                continue
            }
            labels[message.id] = label(
                for: createdAt,
                now: now,
                calendar: calendar,
                locale: locale
            )
        }
        return labels
    }

    /// Same day and close behind its predecessor means the reader still has the
    /// time in view; anything else reopens the question.
    private static func opensSeparator(
        _ createdAt: Date,
        after previous: Date,
        calendar: Calendar
    ) -> Bool {
        !calendar.isDate(createdAt, inSameDayAs: previous)
            || createdAt.timeIntervalSince(previous) >= quietGap
    }

    /// Today needs only a clock time; older days carry just enough date to place
    /// them without turning into a header.
    static func label(
        for createdAt: Date,
        now: Date = .now,
        calendar: Calendar = .current,
        locale: Locale = .current
    ) -> String {
        let style = Date.FormatStyle(
            locale: locale,
            calendar: calendar,
            timeZone: calendar.timeZone
        )
        let time = createdAt.formatted(style.hour().minute())
        guard !calendar.isDate(createdAt, inSameDayAs: now) else { return time }

        let daysBack = calendar.dateComponents(
            [.day],
            from: calendar.startOfDay(for: createdAt),
            to: calendar.startOfDay(for: now)
        ).day ?? 0

        switch daysBack {
        case 1:
            return "Yesterday \(time)"
        case 2...6:
            return "\(createdAt.formatted(style.weekday(.abbreviated))) \(time)"
        default:
            let sameYear = calendar.component(.year, from: createdAt)
                == calendar.component(.year, from: now)
            let day = sameYear
                ? createdAt.formatted(style.month(.abbreviated).day())
                : createdAt.formatted(style.month(.abbreviated).day().year())
            return "\(day) \(time)"
        }
    }
}
