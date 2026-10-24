import Foundation

@MainActor
enum NativeTimestampParser {
    private static let fractionalStyle = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let wholeSecondStyle = Date.ISO8601FormatStyle()
    private static let fractionalFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let wholeSecondFormatter = ISO8601DateFormatter()

    static func parse(_ value: String) -> Date? {
        if isStandardServerTimestamp(value) {
            let style = value.utf8.count == 24 ? fractionalStyle : wholeSecondStyle
            if let parsed = try? style.parse(value) {
                // Match the existing formatter's millisecond date values.
                return Date(timeIntervalSince1970: (parsed.timeIntervalSince1970 * 1_000).rounded() / 1_000)
            }
        }
        return fractionalFormatter.date(from: value) ?? wholeSecondFormatter.date(from: value)
    }

    /// The modern parser accepts invalid clock values and keeps extra fractional
    /// precision. Use it only for normal UTC server timestamps.
    private static func isStandardServerTimestamp(_ value: String) -> Bool {
        value.utf8.withContiguousStorageIfAvailable { bytes in
            guard bytes.count == 20 || bytes.count == 24 else { return false }
            for index in bytes.indices {
                let byte = bytes[index]
                switch index {
                case 4, 7:
                    guard byte == UInt8(ascii: "-") else { return false }
                case 10:
                    guard byte == UInt8(ascii: "T") else { return false }
                case 13, 16:
                    guard byte == UInt8(ascii: ":") else { return false }
                case 19:
                    guard byte == (bytes.count == 20 ? UInt8(ascii: "Z") : UInt8(ascii: ".")) else { return false }
                case 23:
                    guard byte == UInt8(ascii: "Z") else { return false }
                default:
                    guard (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte) else { return false }
                }
            }
            let hour = (bytes[11] - UInt8(ascii: "0")) * 10 + bytes[12] - UInt8(ascii: "0")
            return hour < 24 && bytes[14] <= UInt8(ascii: "5") && bytes[17] <= UInt8(ascii: "5")
        } ?? false
    }
}
