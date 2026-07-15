import SwiftUI

/// Shared metrics for Alpine's Liquid Glass chrome. Icon-only actions remain
/// circular; labeled control groups use the squarer nature-theme geometry.
enum AlpineControls {
    /// Diameter for compact circular icon controls.
    static let controlDiameter: CGFloat = 30

    /// SF Symbol treatment for compact glass controls.
    static let iconFont: Font = .system(size: 13, weight: .medium)

    /// Model, effort, tier, and access controls need enough vertical presence
    /// to read as deliberate desktop controls rather than tiny text pills.
    static let segmentHeight: CGFloat = 34
    static let segmentHorizontalPadding: CGFloat = 10
    static let segmentVerticalPadding: CGFloat = 6
}

extension View {
    /// Sizes an icon label for Alpine's circular glass buttons.
    func alpineIconLabel() -> some View {
        font(AlpineControls.iconFont)
            .frame(
                width: AlpineControls.controlDiameter,
                height: AlpineControls.controlDiameter
            )
            .contentShape(Circle())
    }
}
