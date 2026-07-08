import Foundation
import T3Kit

/// Detail strings are immutable per lifecycle state, so parse results are
/// cached across row rebuilds and grouping passes. Bounded: cleared wholesale
/// past 512 entries (a timeline swap's worth) rather than tracking LRU order.
@MainActor
enum ToolDetailParseCache {
    private static var storage: [String: ParsedToolDetail] = [:]

    static func parsed(detail: String, itemType: String?) -> ParsedToolDetail {
        let key = (itemType ?? "") + "\u{1F}" + detail
        if let hit = storage[key] { return hit }
        let value = ParsedToolDetail.parse(detail: detail, itemType: itemType)
        if storage.count >= 512 { storage.removeAll(keepingCapacity: true) }
        storage[key] = value
        return value
    }
}
