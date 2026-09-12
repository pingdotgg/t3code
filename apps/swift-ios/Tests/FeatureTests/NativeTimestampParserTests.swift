import Foundation
import Testing
@testable import T3Code

@MainActor
@Suite("Native timestamps")
struct NativeTimestampParserTests {
    @Test
    func standardServerTimestampsKeepExactDateValues() throws {
        for date in ["1970-01-01", "2000-02-29", "2001-01-01", "2026-09-04", "9999-12-31"] {
            for fraction in ["", ".000", ".001", ".123", ".333", ".789", ".999"] {
                let source = "\(date)T12:34:56\(fraction)Z"
                let expected = try #require(legacyDate(source))
                #expect(NativeTimestampParser.parse(source) == expected, "\(source)")
            }
        }
    }

    @Test
    func offsetsAndFractionalPrecisionKeepLegacyBehavior() throws {
        for source in [
            "2026-09-04T12:34:56.123+05:30",
            "2026-09-04T12:34:56-07:00",
            "2026-09-04T12:34:56+0530",
            "2026-09-04T12:34:56+05",
            "2026-09-04T12:34:56.1Z",
            "2026-09-04T12:34:56.12Z",
            "2026-09-04T12:34:56.123456Z",
            "2026-09-04T12:34:56.999999999Z",
            "2026-09-04T12:34:56.000001Z",
        ] {
            let expected = try #require(legacyDate(source))
            #expect(NativeTimestampParser.parse(source) == expected, "\(source)")
        }
    }

    @Test
    func unusualFormsStillUseLegacyRules() {
        for source in [
            "2026-9-4T1:2:3Z",
            "2026-09-04T12:34:56z",
            "2026-09-04T12:34:56Z trailing text",
            "2026-09-04T24:00:00Z",
            "2026-02-30T12:00:00.123Z",
            "0000-01-01T00:00:00Z",
            "+012026-09-04T12:34:56Z",
            "２０２６-09-04T12:34:56Z",
        ] {
            #expect(NativeTimestampParser.parse(source) == legacyDate(source), "\(source)")
        }
    }

    @Test
    func invalidClockValuesAndMalformedTimestampsStayRejected() {
        for source in [
            "", " ", "not a date", "2026-09-04", "2026-09-04T12:34:56",
            "2026-13-01T00:00:00Z", "2026-00-01T00:00:00.000Z",
            "2026-09-04T25:00:00.000Z", "2026-09-04T12:60:00Z",
            "2026-09-04T12:99:00.123Z", "2016-12-31T23:59:60Z",
            "2016-12-31T23:59:60.000Z", "2026-09-04T12:34:99.123Z",
            "2026-09-04T12:34:56.123X",
        ] {
            #expect(legacyDate(source) == nil, "\(source)")
            #expect(NativeTimestampParser.parse(source) == nil, "\(source)")
        }
    }

    private func legacyDate(_ value: String) -> Date? {
        Self.fractionalFormatter.date(from: value) ?? Self.wholeSecondFormatter.date(from: value)
    }

    private static let fractionalFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let wholeSecondFormatter = ISO8601DateFormatter()
}
