import SwiftUI

extension ProjectSceneryPrefs {
    var projectBadgeAccent: Color? {
        guard let accentHex, let rgb = AlpineTheme.RGB(hex: accentHex) else { return nil }
        return rgb.color
    }

    var projectBadgeSymbol: String? {
        guard let sfSymbol, !sfSymbol.isEmpty else { return nil }
        return sfSymbol
    }

    var showsProjectBadge: Bool {
        projectBadgeSymbol != nil || projectBadgeAccent != nil
    }
}

/// Optional per-project mark used in compact chrome. A configured SF Symbol
/// carries the accent; an accent without a symbol becomes a quiet color dot.
struct ProjectSceneryBadge: View {
    let prefs: ProjectSceneryPrefs
    var symbolSize: CGFloat = 11
    var dotSize: CGFloat = 6

    var body: some View {
        Group {
            if let symbol = prefs.projectBadgeSymbol {
                Image(systemName: symbol)
                    .font(.system(size: symbolSize, weight: .semibold))
                    .foregroundStyle(prefs.projectBadgeAccent ?? Color.secondary)
            } else if let accent = prefs.projectBadgeAccent {
                Circle()
                    .fill(accent)
                    .frame(width: dotSize, height: dotSize)
            }
        }
        .accessibilityHidden(true)
    }
}
