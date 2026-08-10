import Foundation
import SwiftUI

struct MarkdownImageContext {
    struct ID: Hashable, Sendable {
        let resolverID: ObjectIdentifier?
        let threadID: String
        let workspaceRoot: String?
        let relativeDirectory: String?
    }

    let assetResolver: (any FeatureWorkspaceAssetResolving)?
    let threadID: String
    let workspaceRoot: String?
    let relativeDirectory: String?

    var id: ID {
        ID(
            resolverID: assetResolver.map(ObjectIdentifier.init),
            threadID: threadID,
            workspaceRoot: workspaceRoot,
            relativeDirectory: relativeDirectory
        )
    }

    init(
        client: any FeatureClient,
        threadID: String,
        workspaceRoot: String?,
        relativeDirectory: String? = nil
    ) {
        assetResolver = client as? any FeatureWorkspaceAssetResolving
        self.threadID = threadID
        self.workspaceRoot = workspaceRoot
        self.relativeDirectory = relativeDirectory
    }
}

struct MarkdownWorkspaceImage: Equatable {
    let previewURL: URL
    let link: FeatureWorkspaceFileLink

    init?(source: String, workspaceRoot: String?, relativeTo basePath: String? = nil) {
        let encodedSource = source.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)
        guard let workspaceRoot,
              let sourceURL = URL(string: source) ?? encodedSource.flatMap(URL.init(string:)),
              let link = FeatureWorkspaceFileLink(
                  url: sourceURL,
                  workspaceRoot: workspaceRoot,
                  relativeTo: basePath
              ),
              FeatureFilePreviewKind.infer(path: link.path) == .image else { return nil }
        let resolvedPath = (workspaceRoot as NSString).appendingPathComponent(link.path)
        previewURL = URL(fileURLWithPath: resolvedPath)
        self.link = link
    }
}

struct MarkdownWorkspaceImageView: View {
    private struct Request: Hashable {
        let reference: MarkdownImageReference
        let contextID: MarkdownImageContext.ID
    }

    let reference: MarkdownImageReference
    let context: MarkdownImageContext

    @SwiftUI.Environment(\.openURL) private var openURL
    @State private var resolvedURL: URL?
    @State private var failed = false

    private var image: MarkdownWorkspaceImage? {
        MarkdownWorkspaceImage(
            source: reference.source,
            workspaceRoot: context.workspaceRoot,
            relativeTo: context.relativeDirectory
        )
    }

    private var name: String {
        let alt = reference.alt?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let alt, !alt.isEmpty { return alt }
        return image?.link.entry.name ?? reference.source
    }

    var body: some View {
        Group {
            if image == nil {
                Text(name)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
            } else if failed {
                Label("Image unavailable: \(name)", systemImage: "exclamationmark.triangle")
                    .font(T3Typography.supporting.monospaced())
                    .foregroundStyle(T3Colors.textSecondary)
                    .padding(9)
                    .overlay { RoundedRectangle(cornerRadius: 8).stroke(T3Colors.border) }
            } else if let resolvedURL, let image {
                Button { openURL(image.previewURL) } label: {
                    FeatureRemoteAttachmentThumbnail(
                        url: resolvedURL,
                        maximumDownloadBytes: 16 * 1_024 * 1_024,
                        onFailure: { failed = true }
                    )
                        .frame(maxWidth: .infinity)
                        .frame(height: 240)
                        .background(T3Colors.surfaceRaised)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Open image \(name)")
                .accessibilityIdentifier("workspace-inline-image")
            } else {
                ProgressView(name)
                    .frame(maxWidth: .infinity)
                    .frame(height: 160)
                    .background(T3Colors.surfaceRaised)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task(id: Request(reference: reference, contextID: context.id)) { await resolve() }
    }

    private func resolve() async {
        resolvedURL = nil
        failed = false
        guard let image else { return }
        do {
            guard let assetResolver = context.assetResolver else {
                throw FeatureCapabilityUnavailable("Inline workspace images")
            }
            resolvedURL = try await assetResolver.workspaceAssetURL(
                threadID: context.threadID,
                path: image.link.path
            )
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled else { return }
            failed = true
        }
    }
}
