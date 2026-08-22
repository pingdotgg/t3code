import SwiftUI
import UIKit

/// Identifies the workspace a Markdown message belongs to so its image
/// references can be resolved through the existing signed asset route.
///
/// The resolver is a main-actor protocol and is only ever touched from view
/// code, so carrying it through the environment is safe.
struct MarkdownWorkspaceImageContext: Equatable, @unchecked Sendable {
    let resolver: any FeatureWorkspaceAssetResolving
    let threadID: String

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.resolver === rhs.resolver && lhs.threadID == rhs.threadID
    }
}

private struct MarkdownWorkspaceImageContextKey: EnvironmentKey {
    static let defaultValue: MarkdownWorkspaceImageContext? = nil
}

extension EnvironmentValues {
    var markdownWorkspaceImageContext: MarkdownWorkspaceImageContext? {
        get { self[MarkdownWorkspaceImageContextKey.self] }
        set { self[MarkdownWorkspaceImageContextKey.self] = newValue }
    }
}

/// Maps a Markdown image destination onto a workspace file path.
///
/// Only a relative path to a supported image inside the workspace can be
/// resolved: remote URLs, data URLs, absolute paths, and path escapes are not
/// workspace files, and files the app cannot decode are not images. Everything
/// this rejects keeps rendering as its alternative text.
enum MarkdownWorkspaceImageReference {
    static func workspacePath(for source: String) -> String? {
        let trimmed = source.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              trimmed.range(of: #"^[A-Za-z][A-Za-z0-9+.\-]*:"#, options: .regularExpression) == nil,
              !trimmed.hasPrefix("/"),
              !trimmed.hasPrefix("~"),
              !trimmed.hasPrefix("#") else {
            return nil
        }

        let decoded = trimmed.removingPercentEncoding ?? trimmed
        var components: [String] = []
        for component in decoded.split(separator: "/", omittingEmptySubsequences: false) {
            switch component {
            case ".":
                continue
            case "", "..":
                return nil
            default:
                components.append(String(component))
            }
        }

        let path = components.joined(separator: "/")
        guard !path.isEmpty, FeatureFilePreviewKind.infer(path: path) == .image else {
            return nil
        }
        return path
    }
}

/// Resolves the workspace asset on every view load so an overwritten file can
/// produce a new signed URL. The shared attachment loader still deduplicates
/// downloads while that exact URL remains current.
@MainActor
enum MarkdownWorkspaceImageLoader {
    static func image(
        threadID: String,
        path: String,
        maximumPixelSize: Int,
        resolver: any FeatureWorkspaceAssetResolving,
        loadImage: (URL, Int) async throws -> UIImage = { url, maximumPixelSize in
            try await FeatureAttachmentThumbnailLoader.image(
                for: url,
                maximumPixelSize: maximumPixelSize
            )
        }
    ) async throws -> UIImage {
        let url = try await resolver.workspaceAssetURL(threadID: threadID, path: path)
        return try await loadImage(url, maximumPixelSize)
    }
}

/// Renders a workspace image referenced by a Markdown message inline, reusing
/// the transcript's attachment thumbnail loader and its bounded image cache.
struct MarkdownWorkspaceImageView: View {
    private struct Request: Hashable {
        let threadID: String
        let path: String
        let maximumPixelSize: Int
    }

    let source: String
    let alt: String

    @SwiftUI.Environment(\.markdownWorkspaceImageContext) private var context
    @SwiftUI.Environment(\.displayScale) private var displayScale
    @State private var image: UIImage?
    // Gated on request identity, like the sibling remote attachment thumbnail:
    // hosted transcript cells reuse this state across recycling and path
    // changes, so an ungated image would briefly belong to another message.
    @State private var loadedRequest: Request?
    @State private var failedRequest: Request?

    var body: some View {
        if let context, let path = MarkdownWorkspaceImageReference.workspacePath(for: source) {
            workspaceImage(path: path, context: context)
        } else {
            // Remote and unsupported references keep the behaviour they have
            // always had: the alternative text reads as prose.
            Text(alt.isEmpty ? source : alt)
                .font(T3Typography.threadBody)
                .foregroundStyle(T3Colors.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func workspaceImage(
        path: String,
        context: MarkdownWorkspaceImageContext
    ) -> some View {
        let request = request(path: path, threadID: context.threadID)
        return Group {
            if loadedRequest == request, let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: .infinity, maxHeight: 340, alignment: .leading)
            } else if failedRequest == request {
                placeholder(systemImage: "photo.badge.exclamationmark", text: "Image unavailable")
            } else {
                placeholder(systemImage: "photo", text: "Loading image…")
            }
        }
        .background(T3Colors.surfaceRaised)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(T3Colors.border, lineWidth: 1)
        }
        .accessibilityElement()
        .accessibilityLabel(accessibilityLabel(path: path, request: request))
        .accessibilityIdentifier("workspace-image-\(path)")
        .task(id: request) {
            await load(request, context: context)
        }
    }

    private func request(path: String, threadID: String) -> Request {
        Request(threadID: threadID, path: path, maximumPixelSize: maximumPixelSize)
    }

    /// Bounded so a large workspace render is downsampled once, off the main
    /// thread, instead of holding its full-resolution bitmap in the transcript.
    private var maximumPixelSize: Int {
        min(1_536, max(390, Int(ceil(390 * displayScale))))
    }

    private func accessibilityLabel(path: String, request: Request) -> String {
        let name = alt.trimmingCharacters(in: .whitespacesAndNewlines)
        let described = name.isEmpty ? URL(fileURLWithPath: path).lastPathComponent : name
        if failedRequest == request {
            return "Image unavailable, \(described)"
        }
        return loadedRequest == request ? "Image, \(described)" : "Loading image, \(described)"
    }

    private func placeholder(systemImage: String, text: String) -> some View {
        VStack(spacing: 7) {
            Image(systemName: systemImage)
                .font(.system(size: 22, weight: .medium))
            Text(text)
                .font(T3Typography.supporting)
        }
        .foregroundStyle(T3Colors.textSecondary)
        .frame(maxWidth: .infinity)
        .frame(height: 160)
    }

    private func load(_ request: Request, context: MarkdownWorkspaceImageContext) async {
        do {
            let loaded = try await MarkdownWorkspaceImageLoader.image(
                threadID: request.threadID,
                path: request.path,
                maximumPixelSize: request.maximumPixelSize,
                resolver: context.resolver
            )
            try Task.checkCancellation()
            image = loaded
            loadedRequest = request
            failedRequest = nil
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled else { return }
            image = nil
            loadedRequest = nil
            failedRequest = request
        }
    }
}
