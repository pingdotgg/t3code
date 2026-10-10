import Foundation

struct MarkdownEmbeddedMedia: Equatable, Sendable {
    let source: MarkdownImageSource
    let isVideo: Bool

    init(_ rawSource: String, workspaceRoot: String? = nil) {
        source = MarkdownImageSource.classify(rawSource, workspaceRoot: workspaceRoot)
        let path: String
        switch source {
        case let .direct(url):
            if url.absoluteString.lowercased().hasPrefix("data:video/") {
                isVideo = true
                return
            }
            path = url.path
        case let .workspaceFile(value): path = value
        case .blocked:
            isVideo = false
            return
        }
        // Workspace paths were already decoded by MarkdownImageSource. Literal #,
        // ? and % characters must not be parsed as another URL here.
        isVideo = FeatureAttachmentContentKind.videoExtensions.contains((path as NSString).pathExtension.lowercased())
    }

    var previewURL: URL? {
        switch source {
        case let .direct(url):
            return ["http", "https"].contains(url.scheme?.lowercased() ?? "") ? url : nil
        case let .workspaceFile(path):
            var components = URLComponents()
            components.scheme = "t3code"
            components.host = "media-preview"
            components.path = "/open"
            components.queryItems = [
                URLQueryItem(name: "path", value: path),
                URLQueryItem(name: "kind", value: isVideo ? "video" : "image"),
            ]
            return components.url
        case .blocked: return nil
        }
    }

    @MainActor
    func resolveURL(context: MarkdownImageContext?) async throws -> URL {
        switch source {
        case let .direct(url): return url
        case let .workspaceFile(path):
            guard let context else { throw FeatureCapabilityUnavailable("Host media") }
            return try await context.resolver.mediaAsset(threadID: context.threadID, path: path).url
        case .blocked: throw FeatureMediaPreviewError.invalidResponse
        }
    }
}
