import Foundation

/// Cost signal attached to an effort level. `high` and everything below it are
/// deliberately routine: those are the useful everyday choices. The tiers
/// above it escalate independently from the color ramp because `xhigh`, `max`,
/// and unlimited subagent modes have materially different usage risk.
enum EffortCostTier: Int, Comparable, Sendable {
    case standard
    case extraHigh
    case maximum
    case unlimited

    static func < (lhs: EffortCostTier, rhs: EffortCostTier) -> Bool {
        lhs.rawValue < rhs.rawValue
    }

    var badgeLabel: String? {
        switch self {
        case .standard: nil
        case .extraHigh: "TOKENS ↑"
        case .maximum: "HEAVY BURN"
        case .unlimited: "LIMIT RISK"
        }
    }

    var detail: String? {
        switch self {
        case .standard: nil
        case .extraHigh: "Token use climbs faster"
        case .maximum: "Heavy burn · smaller gains"
        case .unlimited: "Subagents can burn at full effort"
        }
    }

    var accessibilityWarning: String? {
        switch self {
        case .standard: nil
        case .extraHigh: "Uses substantially more tokens than High."
        case .maximum: "May burn tokens very quickly for limited additional capability."
        case .unlimited:
            "Extreme usage risk. The main agent and its subagents may all use the highest effort."
        }
    }

    /// The loops only mount while the small effort popover is visible.
    var animationFrameInterval: Double {
        switch self {
        case .standard: 1
        case .extraHigh: 1.0 / 12.0
        case .maximum: 1.0 / 20.0
        case .unlimited: 1.0 / 30.0
        }
    }

    var particleCount: Int {
        switch self {
        case .standard: 0
        case .extraHigh: 3
        case .maximum: 8
        case .unlimited: 16
        }
    }
}

/// Pure mapping from a provider's reasoning-effort choice to a stable slot on
/// the app's playful effort ramp (color index + symbol). Kept free of SwiftUI
/// so the ramp's ordering and keyword handling are directly testable, and so
/// the SwiftUI layer only translates slots into shared theme tokens.
struct EffortLevelStyle: Equatable, Sendable {
    /// Position on the ramp: 0 = calmest, `slotCount - 1` = most intense.
    let slot: Int
    /// Normalized intensity (0...1), used to scale effect strength.
    let rank: Double
    let costTier: EffortCostTier

    static let slotCount = 7

    /// SF Symbols per slot, calm → intense. All predate SF Symbols 5.
    static let slotSymbols = [
        "leaf.fill",
        "brain.head.profile",
        "brain",
        "bolt.fill",
        "flame.fill",
        "burst.fill",
        "exclamationmark.triangle.fill",
    ]

    var symbolName: String { Self.slotSymbols[slot] }

    init(slot: Int, rank: Double, costTier: EffortCostTier = .standard) {
        self.slot = slot
        self.rank = rank
        self.costTier = costTier
    }

    /// Resolve a choice to a ramp slot. Well-known wire ids ("low", "high",
    /// "max", "ultrathink", …) pin the rank semantically; anything else falls
    /// back to the choice's ordinal position within the model's option list,
    /// which providers order from least to most intense.
    static func resolve(choiceID: String, index: Int, count: Int) -> EffortLevelStyle {
        let semantic = keywordStyle(choiceID)
        let rank = semantic?.rank ?? ordinalRank(index: index, count: count)
        let slot = Int((rank * Double(slotCount - 1)).rounded())
        return EffortLevelStyle(
            slot: min(max(slot, 0), slotCount - 1),
            rank: rank,
            costTier: semantic?.costTier ?? .standard)
    }

    private static func keywordStyle(_ id: String) -> (
        rank: Double, costTier: EffortCostTier
    )? {
        let id = id.lowercased()
        let compactID = id.filter(\.isLetter)
        let step = 1.0 / Double(slotCount - 1)

        // Order matters: "xhigh" contains "high", "minimal" contains "min".
        // Ultrathink is a prompt mode, not the unlimited-subagent Ultracode
        // mode, so it gets Max's warning rather than the most severe tier.
        if compactID == "ultra" || compactID.contains("ultracode") {
            return (1, .unlimited)
        }
        if compactID.contains("ultrathink") || id.contains("max") {
            return (step * 5, .maximum)
        }
        if id.contains("xhigh") { return (step * 4, .extraHigh) }
        if id.contains("none") || id.contains("off") || id.contains("min") {
            return (0, .standard)
        }
        if id.contains("high") { return (step * 3, .standard) }
        if id.contains("med") { return (step * 2, .standard) }
        if id.contains("low") { return (step, .standard) }
        return nil
    }

    private static func ordinalRank(index: Int, count: Int) -> Double {
        guard count > 1 else { return 0.5 }
        return Double(min(max(index, 0), count - 1)) / Double(count - 1)
    }
}
