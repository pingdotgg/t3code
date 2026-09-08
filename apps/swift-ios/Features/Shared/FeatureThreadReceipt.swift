import Foundation

/// Records receipt on this device, separately from a message’s server timestamp.
public struct FeatureThreadReceipt: Sendable, Equatable {
    public enum Source: Sendable, Equatable {
        case detailEvent
        case detailSnapshot
        case shellThreadUpdate
    }

    public let threadID: String
    public let receivedAt: Date
    public let source: Source

    public init(threadID: String, receivedAt: Date, source: Source) {
        self.threadID = threadID
        self.receivedAt = receivedAt
        self.source = source
    }

    func formattedTimestamp(locale: Locale = .current, timeZone: TimeZone = .current) -> String {
        receivedAt.formatted(Date.FormatStyle(
            date: .numeric, time: .standard, locale: locale, timeZone: timeZone
        ))
    }

}
