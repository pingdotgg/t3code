import Foundation
import UniformTypeIdentifiers

struct T3LoadedSharePayload: Sendable {
    var textFragments: [String]
    var images: [T3PendingShareImage]
    var warnings: [String]
}

enum T3SharePayloadLoader {
    static func load(from inputItems: [Any]) async -> T3LoadedSharePayload {
        var textFragments: [String] = []
        var images: [T3PendingShareImage] = []
        var skippedOversizedImage = false
        var skippedExcessImage = false

        for case let item as NSExtensionItem in inputItems {
            if let attributedText = item.attributedContentText?.string {
                textFragments.append(attributedText)
            }

            for provider in item.attachments ?? [] {
                if let imageType = provider.registeredTypeIdentifiers.first(where: {
                    UTType($0)?.conforms(to: .image) == true
                }) {
                    guard images.count < T3IncomingShareStore.maximumImageCount else {
                        skippedExcessImage = true
                        continue
                    }
                    do {
                        let staged = try await loadStagedImage(
                            from: provider,
                            typeIdentifier: imageType
                        )
                        images.append(
                            T3PendingShareImage(
                                stagedFileURL: staged.url,
                                byteCount: staged.byteCount,
                                suggestedName: provider.suggestedName,
                                typeIdentifier: imageType
                            )
                        )
                    } catch T3SharePayloadLoaderError.imageTooLarge {
                        skippedOversizedImage = true
                    } catch {
                        // An image provider is terminal even if it also vends a
                        // URL or text representation. Falling through would
                        // silently turn a rejected attachment into other input.
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
        if skippedExcessImage {
            warnings.append(
                "Only the first \(T3IncomingShareStore.maximumImageCount) shared images were attached."
            )
        }
        return T3LoadedSharePayload(
            textFragments: textFragments,
            images: images,
            warnings: warnings
        )
    }

    private static func loadStagedImage(
        from provider: NSItemProvider,
        typeIdentifier: String
    ) async throws -> (url: URL, byteCount: Int) {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { url, error in
                do {
                    guard let url else {
                        throw error ?? CocoaError(.fileReadUnknown)
                    }
                    continuation.resume(returning: try stageImage(from: url))
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    /// The provider-owned URL expires when its callback returns. Stream it to
    /// an extension-owned temporary file while enforcing the byte limit, so a
    /// malicious or enormous provider never has to be materialized in memory.
    private static func stageImage(from sourceURL: URL) throws -> (url: URL, byteCount: Int) {
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
                guard byteCount <= T3IncomingShareStore.maximumImageBytes else {
                    throw T3SharePayloadLoaderError.imageTooLarge
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
    case imageTooLarge
}
