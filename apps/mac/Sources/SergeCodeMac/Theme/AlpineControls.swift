import SwiftUI

/// Shared control metrics for Alpine's circular Liquid Glass chrome: compact
/// SF Symbol buttons that align with native toolbar controls while primary
/// actions continue to use `AlpineTheme.accent`.
enum AlpineControls {
    /// Diameter for compact circular icon controls.
    static let controlDiameter: CGFloat = 30

    /// SF Symbol treatment for compact glass controls.
    static let iconFont: Font = .system(size: 13, weight: .medium)
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
