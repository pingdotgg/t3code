import SwiftUI

extension EnvironmentValues {
    @Entry var featureThreadViewportHeight: CGFloat? = nil
}

enum FeatureThreadViewport {
    static func panelHeight(_ preferred: CGFloat, in viewportHeight: CGFloat?) -> CGFloat {
        guard let viewportHeight, viewportHeight.isFinite else { return preferred }
        return min(preferred, max(44, viewportHeight * 0.35))
    }
}
