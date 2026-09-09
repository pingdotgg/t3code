import SwiftUI

struct FeatureMessageAge {
    let sentAt: Date

    static func lastMessageDate(in messages: [FeatureMessage]) -> Date? {
        messages.last {
            ($0.role == .user || $0.role == .assistant) && $0.state != .queued
        }?.createdAt
    }

    func text(at now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(sentAt)))
        if seconds < 60 { return "\(seconds)s" }
        if seconds < 3_600 { return "\(seconds / 60)m" }
        if seconds < 86_400 { return "\(seconds / 3_600)h" }
        return "\(seconds / 86_400)d"
    }
}

/// Message age belongs to the activity row, not connection or snapshot status.
struct FeatureMessageAgeView: View {
    let sentAt: Date

    var body: some View {
        TimelineView(MessageAgeSchedule(sentAt: sentAt)) { context in
            Text("Last message · \(FeatureMessageAge(sentAt: sentAt).text(at: context.date)) ago")
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textTertiary)
        }
        .accessibilityIdentifier("thread-last-message-age")
    }
}

/// Wake only at the next displayed second, minute, hour, or day boundary.
private struct MessageAgeSchedule: TimelineSchedule {
    let sentAt: Date

    func entries(from startDate: Date, mode: TimelineScheduleMode) -> AnySequence<Date> {
        AnySequence {
            var next = startDate
            return AnyIterator<Date> {
                let date = next
                let age = max(0, date.timeIntervalSince(sentAt))
                let unit: TimeInterval = age < 60 ? 1 : age < 3_600 ? 60 : age < 86_400 ? 3_600 : 86_400
                next = sentAt.addingTimeInterval((floor(age / unit) + 1) * unit)
                return date
            }
        }
    }
}
