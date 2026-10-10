import Foundation
import ImageIO
import SwiftUI
import UIKit

struct FeatureToolOutputImage: Identifiable, Equatable, Sendable {
    let index: Int
    let mimeType: String
    var id: Int { index }
    var fileName: String {
        let suffix = switch mimeType {
        case "image/jpeg": "jpg"
        case "image/gif": "gif"
        case "image/webp": "webp"
        default: "png"
        }
        return "tool-image-\(index + 1).\(suffix)"
    }
}

enum FeatureToolOutputImages {
    static let maximumCount = 8

    static func mimeType(_ block: JSONValue) -> String? {
        guard block["type"]?.stringValue == "image" else { return nil }
        let mime: String?
        if let source = block["source"], case .object = source {
            guard block["source"]?["type"]?.stringValue == "base64" else { return nil }
            mime = block["source"]?["media_type"]?.stringValue
        } else {
            mime = block["mimeType"]?.stringValue
        }
        guard let mime = mime?.lowercased(), ["image/png", "image/jpeg", "image/gif", "image/webp"].contains(mime) else { return nil }
        return mime
    }

    static func images(_ raw: JSONValue) -> [FeatureToolOutputImage] {
        guard raw["type"]?.stringValue == "dynamic_tool", raw["outputOmitted"]?.boolValue != true,
              let output = raw["output"] else { return [] }
        let blocks = output.v2Array ?? output["content"]?.v2Array ?? [output]
        return blocks.lazy.compactMap(mimeType).prefix(maximumCount).enumerated().map {
            FeatureToolOutputImage(index: $0.offset, mimeType: $0.element)
        }
    }

    /// Strip only the accessible top-level markers. Nested or unsupported images keep a placeholder.
    static func textOutput(_ output: JSONValue) -> JSONValue {
        var remaining = maximumCount
        func block(_ value: JSONValue) -> JSONValue {
            guard remaining > 0, mimeType(value) != nil else { return value }
            remaining -= 1
            return .object(["type": .string("text"), "text": .string("")])
        }
        if let values = output.v2Array { return .array(values.map(block)) }
        if let values = output["content"]?.v2Array {
            var fields = output.v2Object
            fields["content"] = .array(values.map(block))
            return .object(fields)
        }
        return block(output)
    }
}

@MainActor
public protocol FeatureToolOutputImageResolving: AnyObject {
    func toolOutputImageURL(threadID: String, source: OrchestrationV2TimelineMetadata, index: Int) async throws -> URL
}

@MainActor
struct FeatureToolOutputImageContext {
    let threadID: String
    let resolver: any FeatureToolOutputImageResolving
}

struct FeatureToolOutputImagesView: View {
    let images: [FeatureToolOutputImage]
    let source: OrchestrationV2TimelineMetadata
    let context: FeatureToolOutputImageContext?

    var body: some View {
        ForEach(images) { image in
            if let context {
                FeatureToolOutputImageView(image: image, source: source, context: context)
                    .id("\(context.threadID):\(source.sourceThreadID):\(source.itemID):\(source.detailRevision):\(image.index)")
            } else {
                Text("Connect to view image \(image.index + 1).")
            }
        }
    }
}

/// Starts only when an expanded image row appears. Each load gets one fresh-URL retry.
@MainActor
final class FeatureToolOutputImageLoader: ObservableObject {
    @Published private(set) var image: UIImage?
    @Published private(set) var url: URL?
    @Published private(set) var failed = false
    private var isLoading = false

    func load(
        resolve: @MainActor () async throws -> URL,
        fetch: @Sendable (URL) async throws -> (Data, URLResponse) = { try await URLSession.shared.data(from: $0) }
    ) async {
        guard image == nil, !isLoading else { return }
        isLoading = true
        failed = false
        defer { isLoading = false }
        for attempt in 0..<2 {
            do {
                let resolved = try await resolve()
                let (data, response) = try await fetch(resolved)
                try Task.checkCancellation()
                guard let response = response as? HTTPURLResponse,
                      (200...299).contains(response.statusCode), data.count <= 64 * 1_024 * 1_024 else {
                    throw FeatureMediaPreviewError.invalidResponse
                }
                let thumbnail = try await Task.detached(priority: .utility) {
                    guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
                          let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                            kCGImageSourceCreateThumbnailFromImageAlways: true,
                            kCGImageSourceCreateThumbnailWithTransform: true,
                            kCGImageSourceThumbnailMaxPixelSize: 1200,
                            kCGImageSourceShouldCacheImmediately: true,
                          ] as CFDictionary) else { throw FeatureMediaPreviewError.invalidResponse }
                    return UIImage(cgImage: image)
                }.value
                try Task.checkCancellation()
                image = thumbnail
                url = resolved
                return
            } catch {
                if Task.isCancelled { return }
                if attempt == 1 { failed = true }
            }
        }
    }
}

private struct FeatureToolOutputImageView: View {
    let image: FeatureToolOutputImage
    let source: OrchestrationV2TimelineMetadata
    let context: FeatureToolOutputImageContext
    @StateObject private var loader = FeatureToolOutputImageLoader()
    @State private var preview = false
    @State private var generation = 0
    @SwiftUI.Environment(\.featureThreadPresentationDismissal) private var presentationDismissal
    @State private var presentationID = UUID()

    var body: some View {
        Group {
            if loader.failed {
                Button("Retry image \(image.index + 1)") { generation += 1 }
            } else if let thumbnail = loader.image {
                Button { preview = true } label: {
                    Image(uiImage: thumbnail).resizable().scaledToFit().frame(maxHeight: 280)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Open tool image \(image.index + 1)")
            } else {
                Text("Loading image…").frame(height: 80)
            }
        }
        .task(id: generation) { await loader.load(resolve: resolve) }
        .onChange(of: preview) { _, presented in
            if presented { presentationDismissal.onPresentationChange(presentationID, true) }
        }
        .onChange(of: presentationDismissal.requestID) { _, id in if id != nil { preview = false } }
        .sheet(isPresented: $preview, onDismiss: { presentationDismissal.onPresentationChange(presentationID, false) }) {
            if let url = loader.url {
                NavigationStack {
                    FeatureNativeMediaPreviewView(source: .remote(url), kind: .image,
                        fileName: image.fileName, mimeType: image.mimeType, resolveURL: resolve)
                        .toolbar { ToolbarItem(placement: .topBarLeading) { Button("Done") { preview = false } } }
                }
                .preferredColorScheme(.dark)
            }
        }
    }

    private func resolve() async throws -> URL {
        try await context.resolver.toolOutputImageURL(threadID: context.threadID, source: source, index: image.index)
    }
}
