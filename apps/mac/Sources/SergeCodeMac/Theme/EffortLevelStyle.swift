import Foundation

/// Pure mapping from a provider's reasoning-effort choice to a stable slot on
/// the app's playful effort ramp (color index + symbol). Kept free of SwiftUI
/// so the ramp's ordering and keyword handling are directly testable, and so
/// the SwiftUI layer only translates slots into shared theme tokens.
struct EffortLevelStyle: Equatable, Sendable {
    /// Position on the ramp: 0 = calmest, `slotCount - 1` = most intense.
    let slot: Int
    /// Normalized intensity (0...1), used to scale effect strength.
    let rank: Double

    static let slotCount = 5

    /// SF Symbols per slot, calm → intense. All predate SF Symbols 5.
    static let slotSymbols = [
        "leaf.fill",
        "brain.head.profile",
        "brain",
        "flame.fill",
        "sparkles",
    ]

    var symbolName: String { Self.slotSymbols[slot] }

    /// Resolve a choice to a ramp slot. Well-known wire ids ("low", "high",
    /// "max", "ultrathink", …) pin the rank semantically; anything else falls
    /// back to the choice's ordinal position within the model's option list,
    /// which providers order from least to most intense.
    static func resolve(choiceID: String, index: Int, count: Int) -> EffortLevelStyle {
        let rank = keywordRank(choiceID) ?? ordinalRank(index: index, count: count)
        let slot = Int((rank * Double(slotCount - 1)).rounded())
        return EffortLevelStyle(slot: min(max(slot, 0), slotCount - 1), rank: rank)
    }

    private static func keywordRank(_ id: String) -> Double? {
        let id = id.lowercased()
        // Order matters: "xhigh" contains "high", "minimal" contains "min".
        if id.contains("none") || id.contains("off") || id.contains("min") { return 0 }
        if id.contains("ultra") || id.contains("max") || id.contains("xhigh") { return 1 }
        if id.contains("high") { return 0.75 }
        if id.contains("med") { return 0.5 }
        if id.contains("low") { return 0.25 }
        return nil
    }

    private static func ordinalRank(index: Int, count: Int) -> Double {
        guard count > 1 else { return 0.5 }
        return Double(min(max(index, 0), count - 1)) / Double(count - 1)
    }
}
