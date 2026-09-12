import SwiftUI

struct FeatureToolActivityIcon: View {
    let presentation: ToolActivityPresentation?
    let context: MarkdownImageContext?
    @SwiftUI.Environment(\.colorScheme) private var colorScheme
    @State private var nativeURL: URL?

    private var url: URL? {
        nativeURL ?? (colorScheme == .dark ? presentation?.darkURL ?? presentation?.lightURL : presentation?.lightURL)
    }

    private var fallback: String {
        switch presentation?.surface {
        case "browser": "globe"
        case "computer": "desktopcomputer"
        default: "terminal"
        }
    }

    var body: some View {
        AsyncImage(url: url) { image in
            image.resizable().scaledToFit()
        } placeholder: {
            Image(systemName: fallback)
        }
        .frame(width: 16, height: 16)
        .accessibilityHidden(true)
        .task(id: presentation) {
            nativeURL = nil
            guard let context, let app = presentation?.nativeApp else { return }
            let url = try? await context.resolver.nativeAppIconURL(threadID: context.threadID, app: app)
            guard !Task.isCancelled else { return }
            nativeURL = url
        }
    }
}
