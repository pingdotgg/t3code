import SwiftUI

struct ChatWallpaperBackground: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        LinearGradient(
            colors: [
                Color(.systemBackground),
                Color(.secondarySystemBackground).opacity(reduceTransparency ? 1 : 0.65),
                Color.accentColor.opacity(reduceTransparency ? 0.03 : 0.08),
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
        .overlay(alignment: .topTrailing) {
            Circle()
                .fill(Color.accentColor.opacity(reduceTransparency ? 0.03 : 0.08))
                .frame(width: 240, height: 240)
                .blur(radius: reduceMotion || reduceTransparency ? 0 : 36)
                .offset(x: 80, y: -80)
                .accessibilityHidden(true)
        }
        .ignoresSafeArea()
    }
}

#Preview {
    ChatWallpaperBackground()
}
