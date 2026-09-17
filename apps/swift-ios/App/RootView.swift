import SwiftUI

/// Owns app-wide presentation while the injected feature root owns product navigation.
struct RootView<Content: View>: View {
    private let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        content
            .background(T3Colors.background.ignoresSafeArea())
            .tint(T3Colors.accent)
    }
}
