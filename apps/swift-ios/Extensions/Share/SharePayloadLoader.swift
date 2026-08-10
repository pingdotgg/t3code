import Foundation
import UniformTypeIdentifiers

struct T3LoadedSharePayload: Sendable {
    var textFragments: [String]
    var images: [T3PendingShareImage]
    var videos: [T3PendingShareVideo]
    var warnings: [String]
}

enum T3SharePayloadLoader {
    static func load(from inputItems: [Any]) async -> T3LoadedSharePayload {
        var textFragments: [String] = []
        var images: [T3PendingShareImage] = []
        var videos: [T3PendingShareVideo] = []
        var skippedOversizedImage = false
        var skippedOversizedVideo = false
        var skippedUnreadableImage = false
        var skippedUnreadableVideo = false
        var skippedExcessMedia = false

        for case let item as NSExtensionItem in inputItems {
            if let attributedText = item.attributedContentText?.string {
                textFragments.append(attributedText)
            }

            for provider in item.attachments ?? [] {
                if let videoType = provider.registeredTypeIdentifiers.first(where: {
                    UTType($0)?.conforms(to: .movie) == true
                }) {
                    guard videos.count < T3IncomingShareStore.maximumVideoCount,
                          images.count + videos.count < T3IncomingShareStore.maximumAttachmentCount else {
                        skippedExcessMedia = true
                        continue
                    }
                    do {
                        let staged = try await loadStagedFile(
                            from: provider,
                            typeIdentifier: videoType,
                            maximumBytes: T3IncomingShareStore.maximumVideoBytes
                        )
                        videos.append(
                            T3PendingShareVideo(
                                stagedFileURL: staged.url,
                                byteCount: staged.byteCount,
                                suggestedName: provider.suggestedName,
                                typeIdentifier: videoType
                            )
                        )
                    } catch T3SharePayloadLoaderError.fileTooLarge {
                        skippedOversizedVideo = true
                    } catch {
                        // A movie provider is terminal even if it also vends a
                        // thumbnail. Preserve the user's choice instead of
                        // silently substituting a still image.
                        skippedUnreadableVideo = true
                    }
                    continue
                }

                if let imageType = provider.registeredTypeIdentifiers.first(where: {
                    UTType($0)?.conforms(to: .image) == true
                }) {
                    guard images.count < T3IncomingShareStore.maximumImageCount,
                          images.count + videos.count < T3IncomingShareStore.maximumAttachmentCount else {
                        skippedExcessMedia = true
                        continue
                    }
                    do {
                        let staged = try await loadStagedFile(
                            from: provider,
                            typeIdentifier: imageType,
                            maximumBytes: T3IncomingShareStore.maximumImageBytes
                        )
                        images.append(
                            T3PendingShareImage(
                                stagedFileURL: staged.url,
                                byteCount: staged.byteCount,
                                suggestedName: provider.suggestedName,
                                typeIdentifier: imageType
                            )
                        )
                    } catch T3SharePayloadLoaderError.fileTooLarge {
                        skippedOversizedImage = true
                    } catch {
                        // An image provider is terminal even if it also vends a
                        // URL or text representation. Falling through would
                        // silently turn a rejected attachment into other input.
                        skippedUnreadableImage = true
                    }
                    continue
                }

                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                   let value = try? await loadItem(
                       from: provider,
                       typeIdentifier: UTType.url.identifier
                   ),
                   let urlText = urlString(from: value)
                {
                    textFragments.append(urlText)
                    continue
                }

                if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                   let value = try? await loadItem(
                       from: provider,
                       typeIdentifier: UTType.plainText.identifier
                   ),
                   let text = textString(from: value)
                {
                    textFragments.append(text)
                }
            }
        }

        var warnings: [String] = []
        if skippedOversizedImage {
            warnings.append("One shared image exceeded the 10 MB attachment limit.")
        }
        if skippedOversizedVideo {
            warnings.append("One shared video exceeded the 250 MB import limit.")
        }
        if skippedUnreadableImage {
            warnings.append("One shared image could not be read and was not imported.")
        }
        if skippedUnreadableVideo {
            warnings.append("One shared video could not be read and was not imported.")
        }
        if skippedExcessMedia {
            warnings.append(
                "Only the first \(T3IncomingShareStore.maximumAttachmentCount) shared media items were kept."
            )
        }
        return T3LoadedSharePayload(
            textFragments: textFragments,
            images: images,
            videos: videos,
            warnings: warnings
        )
    }

    private static func loadStagedFile(
        from provider: NSItemProvider,
        typeIdentifier: String,
        maximumBytes: Int
    ) async throws -> (url: URL, byteCount: Int) {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { url, error in
                do {
                    guard let url else {
                        throw error ?? CocoaError(.fileReadUnknown)
                    }
                    continuation.resume(
                        returning: try stageFile(from: url, maximumBytes: maximumBytes)
                    )
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    /// The provider-owned URL expires when its callback returns. Stream it to
    /// an extension-owned temporary file while enforcing the byte limit, so a
    /// malicious or enormous provider never has to be materialized in memory.
    private static func stageFile(
        from sourceURL: URL,
        maximumBytes: Int
    ) throws -> (url: URL, byteCount: Int) {
        let fileManager = FileManager.default
        let stagingDirectory = fileManager.temporaryDirectory.appending(
            path: "T3CodeShareStaging",
            directoryHint: .isDirectory
        )
        try fileManager.createDirectory(
            at: stagingDirectory,
            withIntermediateDirectories: true
        )
        let stagedURL = stagingDirectory.appending(
            path: UUID().uuidString.lowercased(),
            directoryHint: .notDirectory
        )
        guard fileManager.createFile(atPath: stagedURL.path, contents: nil) else {
            throw CocoaError(.fileWriteUnknown)
        }

        do {
            let source = try FileHandle(forReadingFrom: sourceURL)
            let destination = try FileHandle(forWritingTo: stagedURL)
            defer {
                try? source.close()
                try? destination.close()
            }

            var byteCount = 0
            while let chunk = try source.read(upToCount: 64 * 1_024), !chunk.isEmpty {
                try Task.checkCancellation()
                byteCount += chunk.count
                guard byteCount <= maximumBytes else {
                    throw T3SharePayloadLoaderError.fileTooLarge
                }
                try destination.write(contentsOf: chunk)
            }
            guard byteCount > 0 else { throw CocoaError(.fileReadCorruptFile) }
            return (stagedURL, byteCount)
        } catch {
            try? fileManager.removeItem(at: stagedURL)
            throw error
        }
    }

    private static func loadItem(
        from provider: NSItemProvider,
        typeIdentifier: String
    ) async throws -> NSSecureCoding {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadItem(forTypeIdentifier: typeIdentifier) { value, error in
                if let value {
                    continuation.resume(returning: value)
                } else {
                    continuation.resume(throwing: error ?? CocoaError(.fileReadUnknown))
                }
            }
        }
    }

    private static func urlString(from value: NSSecureCoding) -> String? {
        if let url = value as? URL {
            return url.absoluteString
        }
        if let text = value as? String, URL(string: text) != nil {
            return text
        }
        return nil
    }

    private static func textString(from value: NSSecureCoding) -> String? {
        if let text = value as? String {
            return text
        }
        if let attributedText = value as? NSAttributedString {
            return attributedText.string
        }
        return nil
    }
}

private enum T3SharePayloadLoaderError: Error {
    case fileTooLarge
}
