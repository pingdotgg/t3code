import Foundation
import T3Kit

/// Detail strings are immutable per lifecycle state, so parse results are
/// cached across row rebuilds and grouping passes. Bounded: cleared wholesale
/// past 512 entries (a timeline swap's worth) rather than tracking LRU order.
@MainActor
enum ToolDetailParseCache {
    /// A composite key rather than a joined string. Every visible tool row
    /// looks its detail up at least once per body evaluation, and a file-change
    /// payload runs to kilobytes — building `itemType + separator + detail`
    /// copied all of those bytes on each hit, before hashing them.
    private struct Key: Hashable {
        let itemType: String?
        let detail: String
    }

    private static var storage: [Key: ParsedToolDetail] = [:]

    static func parsed(detail: String, itemType: String?) -> ParsedToolDetail {
        let key = Key(itemType: itemType, detail: detail)
        if let hit = storage[key] { return hit }
        let value = ParsedToolDetail.parse(detail: detail, itemType: itemType)
        if storage.count >= 512 { storage.removeAll(keepingCapacity: true) }
        storage[key] = value
        return value
    }
}
