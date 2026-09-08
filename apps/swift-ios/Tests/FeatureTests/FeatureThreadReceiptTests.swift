import Foundation
import Testing
@testable import T3Code

struct FeatureThreadReceiptTests {
    @Test func timestampIncludesSecondsAndUsesSelectedTimeZone() throws {
        let utc = try #require(TimeZone(secondsFromGMT: 0))
        let sydney = try #require(TimeZone(identifier: "Australia/Sydney"))
        let first = FeatureThreadReceipt(threadID: "a", receivedAt: Date(timeIntervalSince1970: 1788877928), source: .detailEvent)
        let next = FeatureThreadReceipt(threadID: "a", receivedAt: first.receivedAt.addingTimeInterval(1), source: .detailEvent)
        let locale = Locale(identifier: "en_GB")
        let text = first.formattedTimestamp(locale: locale, timeZone: utc)
        #expect(text.contains("14:32:08"))
        #expect(next.formattedTimestamp(locale: locale, timeZone: utc).contains("14:32:09"))
        #expect(first.formattedTimestamp(locale: locale, timeZone: sydney).contains("0:32:08"))
    }
}
