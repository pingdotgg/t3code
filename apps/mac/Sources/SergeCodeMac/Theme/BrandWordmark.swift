import SwiftUI

@MainActor
struct BrandWordmark: View {
    let size: CGFloat

    init(size: CGFloat) {
        self.size = size
    }

    var body: some View {
        Text("SurgeCode")
            .font(.system(size: size, weight: .semibold, design: .rounded))
            .tracking(-0.5 * size / 34)
    }
}
