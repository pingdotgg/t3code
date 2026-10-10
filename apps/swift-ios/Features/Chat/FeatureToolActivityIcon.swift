import SwiftUI
import UIKit

struct FeatureToolActivityIcon: View {
    let presentation: ToolActivityPresentation?
    let context: MarkdownImageContext?
    @SwiftUI.Environment(\.colorScheme) private var colorScheme
    @State private var loaded: (key: String, image: UIImage)?

    /// Decoded icons outlive transcript cells, so a reused row shows its icon
    /// at once instead of fetching and decoding it again.
    @MainActor private static let images: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 128
        return cache
    }()

    private var staticURL: URL? {
        colorScheme == .dark ? presentation?.darkURL ?? presentation?.lightURL : presentation?.lightURL
    }

    /// Native app icon URLs are signed and expire, so those key by thread and app instead.
    private var cacheKey: String? {
        if let app = presentation?.nativeApp, let context {
            return "native:\(context.threadID):\(app._tag):\(app.appId ?? app.displayName ?? ""):\(staticURL?.absoluteString ?? "")"
        }
        return staticURL?.absoluteString
    }

    private var fallback: String {
        switch presentation?.surface {
        case "browser": "globe"
        case "computer": "desktopcomputer"
        default: "terminal"
        }
    }

    var body: some View {
        let key = cacheKey
        let image = key.flatMap { key in
            loaded?.key == key ? loaded?.image : Self.images.object(forKey: key as NSString)
        }
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFit()
            } else {
                Image(systemName: fallback)
            }
        }
        .frame(width: 16, height: 16)
        .accessibilityHidden(true)
        .task(id: key) {
            guard let key else { return }
            // NSCache is not observable, so adopt an icon another cell cached after this body ran.
            if let cached = Self.images.object(forKey: key as NSString) {
                loaded = (key, cached)
                return
            }
            var nativeURL: URL?
            if let context, let app = presentation?.nativeApp {
                nativeURL = try? await context.resolver.nativeAppIconURL(threadID: context.threadID, app: app)
            }
            guard let url = nativeURL ?? staticURL,
                  let decoded = try? await MarkdownImageLoader.load(url, maximumPixelSize: 48),
                  !Task.isCancelled else { return }
            // A static fallback stays local, so the next mount retries the native icon.
            if nativeURL != nil || presentation?.nativeApp == nil {
                Self.images.setObject(decoded.image, forKey: key as NSString)
            }
            loaded = (key, decoded.image)
        }
    }
}
