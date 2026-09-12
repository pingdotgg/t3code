import Foundation

/// Swift port of the order-key math shared by web and React Native
/// (`packages/client-runtime/src/state/threadSort.ts`). Order keys are
/// base-26 fractional indices: a move writes one key that sorts between the
/// moved thread's new neighbors, so threads hosted on other servers are never
/// touched and every client converges on the same order.
enum ThreadOrderPlanner {
    private static let digits = Array("abcdefghijklmnopqrstuvwxyz")

    /// Whether the thread's environment accepts `thread.pin.reorder` /
    /// `thread.active.reorder` writes for this section.
    static func isWritable(_ thread: FeatureThread, section: FeatureThreadOrderSection) -> Bool {
        switch section {
        case .pinned: thread.supportsPinReorder == true
        case .active: thread.supportsActiveReorder == true
        }
    }

    /// Key that sorts strictly between two neighbors; nil bounds mean "top of
    /// the arranged run" / "bottom of the keyed run". Returns nil instead of
    /// trapping when existing keys are corrupt or out of order — callers fall
    /// back to rewriting the section.
    static func orderKeyBetween(before: String?, after: String?) -> String? {
        let a = before ?? ""
        let b = after ?? ""
        if !a.isEmpty, !isValidKey(a) { return nil }
        if !b.isEmpty, !isValidKey(b) { return nil }
        if !b.isEmpty, a >= b { return nil }
        return midpoint(a, b)
    }

    /// Evenly spaced keys for materializing an order. Wider keys keep a
    /// large section from exhausting the space between two-digit keys
    /// (`generateSpreadPinOrderKeys` in client-runtime).
    static func spreadKeys(count: Int) -> [String] {
        guard count > 0 else { return [] }
        var width = 2
        var space = digits.count * digits.count
        while space <= (count + 1) * 2 {
            width += 1
            space *= digits.count
        }
        let step = Double(space) / Double(count + 1)
        var keys: [String] = []
        for index in 0..<count {
            var value = Int((step * Double(index + 1)).rounded())
            // Skip values whose low digit is the minimum (a trailing "a" key).
            if value % digits.count == 0 { value += 1 }
            var key = ""
            for _ in 0..<width {
                key = String(digits[value % digits.count]) + key
                value /= digits.count
            }
            keys.append(key)
        }
        return keys
    }

    /// Assignments needed to realize a new order. When the moved thread sits
    /// between two keyed (or absent) neighbors this is a single write; when a
    /// neighbor is keyless the whole section gets fresh spread keys — a
    /// one-time materialization, after which every move is single-write.
    /// `keysByID` may include rows outside `orderedIDs` (archived, snoozed,
    /// filtered): their keys are reserved so a fresh key never collides with
    /// a hidden row's (`planPinnedReorder` in client-runtime).
    static func planReorder(
        orderedIDs: [String],
        keysByID: [String: String?],
        movedID: String
    ) -> [FeatureThreadOrderAssignment] {
        let visibleIDs = Set(orderedIDs)
        var reservedKeys = Set<String>()
        for (id, key) in keysByID where !visibleIDs.contains(id) {
            if let key { reservedKeys.insert(key) }
        }
        guard let movedIndex = orderedIDs.firstIndex(of: movedID) else { return [] }
        let beforeID = movedIndex > 0 ? orderedIDs[movedIndex - 1] : nil
        let afterID = movedIndex < orderedIDs.count - 1 ? orderedIDs[movedIndex + 1] : nil
        let beforeKey = beforeID.flatMap { keysByID[$0] ?? nil }
        let afterKey = afterID.flatMap { keysByID[$0] ?? nil }
        let beforeUsable = beforeID == nil || beforeKey != nil
        let afterUsable = afterID == nil || afterKey != nil
        if beforeUsable, afterUsable {
            var key = orderKeyBetween(before: beforeKey, after: afterKey)
            while let current = key, reservedKeys.contains(current) {
                key = orderKeyBetween(before: current, after: afterKey)
            }
            if let key {
                return [FeatureThreadOrderAssignment(threadID: movedID, orderKey: key)]
            }
        }
        // Keyless neighbor (or corrupt keys): rewrite the section in the new order.
        let keys = spreadKeys(count: orderedIDs.count + reservedKeys.count)
            .filter { !reservedKeys.contains($0) }
        return orderedIDs.enumerated().compactMap { index, id in
            guard index < keys.count, keys[index] != keysByID[id] ?? nil else { return nil }
            return FeatureThreadOrderAssignment(threadID: id, orderKey: keys[index])
        }
    }

    /// Planner for a drag drop: `ordered` is the section's displayed order
    /// after the drop (same input web passes to `planPinnedReorder`).
    /// `all` keeps hidden rows' keys reserved. Every visible row anchors its
    /// position but a plan exists only when the moved row — and every row a
    /// spread rewrite would touch — can be written: reorder-capable and in
    /// `connectedEnvironmentIDs`. Rows on disconnected servers keep their
    /// stale keys as anchors and are never written, so a spread rewrite
    /// cannot half-land on a dead client.
    static func planDrop(
        ordered: [FeatureThread],
        all: [FeatureThread],
        section: FeatureThreadOrderSection,
        connectedEnvironmentIDs: Set<String>,
        movedID: String
    ) -> [FeatureThreadOrderAssignment]? {
        let writableIDs = writableIDs(
            in: ordered,
            section: section,
            connectedEnvironmentIDs: connectedEnvironmentIDs
        )
        guard writableIDs.contains(movedID) else { return nil }
        let assignments = planReorder(
            orderedIDs: ordered.map(\.id),
            keysByID: keysByID(all, section: section),
            movedID: movedID
        )
        guard !assignments.isEmpty,
              assignments.allSatisfy({ writableIDs.contains($0.threadID) })
        else { return nil }
        return assignments
    }

    private static func keysByID(
        _ all: [FeatureThread],
        section: FeatureThreadOrderSection
    ) -> [String: String?] {
        var keysByID: [String: String?] = [:]
        for thread in all {
            keysByID[thread.id] = section == .pinned ? thread.pinOrderKey : thread.activeOrderKey
        }
        return keysByID
    }

    private static func writableIDs(
        in ordered: [FeatureThread],
        section: FeatureThreadOrderSection,
        connectedEnvironmentIDs: Set<String>
    ) -> Set<String> {
        Set(
            ordered
                .filter {
                    isWritable($0, section: section)
                        && connectedEnvironmentIDs.contains($0.environmentID ?? "")
                }
                .map(\.id)
        )
    }

    private static func isValidKey(_ key: String) -> Bool {
        guard !key.isEmpty, key.allSatisfy({ digits.contains($0) }) else { return false }
        // A trailing minimum digit would leave no room to sort a key
        // immediately before this one; generators never produce it, so treat
        // it as corrupt.
        return key.last != digits[0]
    }

    /// Midpoint of two digit strings interpreted as fractions in (0, 1).
    /// "" stands for the open bound on either side. Requires a < b.
    private static func midpoint(_ a: String, _ b: String) -> String {
        if !b.isEmpty {
            // Recurse past the longest common prefix ("a" pads the shorter side).
            var n = 0
            let aChars = Array(a)
            let bChars = Array(b)
            while n < bChars.count,
                  (n < aChars.count ? aChars[n] : digits[0]) == bChars[n] { n += 1 }
            if n > 0 {
                return String(bChars[0..<n])
                    + midpoint(
                        n < aChars.count ? String(aChars[n...]) : "",
                        String(bChars[n...])
                    )
            }
        }
        let digitA = a.isEmpty ? 0 : digits.firstIndex(of: a.first!)!
        let digitB = b.isEmpty ? digits.count : digits.firstIndex(of: b.first!)!
        if digitB - digitA > 1 {
            return String(digits[(digitA + digitB + 1) / 2])
        }
        // Consecutive leading digits: either b has spare digits to shorten
        // into, or we extend a (never producing a trailing minimum digit).
        if b.count > 1 { return String(b.first!) }
        return String(digits[digitA]) + midpoint(String(a.dropFirst()), "")
    }
}
