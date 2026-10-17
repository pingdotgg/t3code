import Foundation
import UniformTypeIdentifiers

struct T3LoadedSharePayload: Sendable {
    var textFragments: [String]
    var images: [T3PendingShareImage]
    var files: [T3PendingShareFile]
    var warnings: [String]
}

enum T3SharePayloadLoader {
    @MainActor
    static func load(from inputItems: [Any]) async -> T3LoadedSharePayload {
        var textFragments: [String] = []
        var images: [T3PendingShareImage] = []
        var files: [T3PendingShareFile] = []
        var skippedOversizedImage = false
        var skippedOversizedFile = false
        var skippedExcessAttachment = false

        for case let item as NSExtensionItem in inputItems {
            if let attributedText = item.attributedContentText?.string {
                textFragments.append(attributedText)
            }

            for provider in item.attachments ?? [] {
                if let imageType = provider.registeredTypeIdentifiers.first(where: {
                    UTType($0)?.conforms(to: .image) == true
                }) {
                    guard images.count + files.count < T3IncomingShareStore.maximumAttachmentCount else {
                        skippedExcessAttachment = true
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

                if let fileType = provider.registeredTypeIdentifiers.first(where: {
                    guard let type = UTType($0) else { return false }
                    return (type.conforms(to: .movie) || type.conforms(to: .data))
                        && !type.conforms(to: .url)
                        && !type.conforms(to: .text)
                }) {
                    guard images.count + files.count < T3IncomingShareStore.maximumAttachmentCount else {
                        skippedExcessAttachment = true
                        continue
                    }
                    do {
                        let staged = try await loadStagedFile(
                            from: provider,
                            typeIdentifier: fileType,
                            maximumBytes: T3IncomingShareStore.maximumFileBytes
                        )
                        files.append(T3PendingShareFile(
                            stagedFileURL: staged.url,
                            byteCount: staged.byteCount,
                            suggestedName: provider.suggestedName,
                            mimeType: UTType(fileType)?.preferredMIMEType ?? "application/octet-stream"
                        ))
                    } catch T3SharePayloadLoaderError.fileTooLarge {
                        skippedOversizedFile = true
                    } catch {
                        // A file provider is terminal. Do not turn a rejected
                        // attachment into its URL or text representation.
                    }
                    continue
                }

                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                   let urlValue = try? await loadURLItem(
                       from: provider,
                       typeIdentifier: UTType.url.identifier
                   )
                {
                    if urlValue.isFileURL {
                        guard images.count + files.count < T3IncomingShareStore.maximumAttachmentCount else {
                            skippedExcessAttachment = true
                            continue
                        }
                        do {
                            let staged = try stageFile(
                                from: urlValue,
                                maximumBytes: T3IncomingShareStore.maximumFileBytes
                            )
                            let type = UTType(filenameExtension: urlValue.pathExtension)
                            files.append(T3PendingShareFile(
                                stagedFileURL: staged.url,
                                byteCount: staged.byteCount,
                                suggestedName: urlValue.lastPathComponent,
                                mimeType: type?.preferredMIMEType ?? "application/octet-stream"
                            ))
                        } catch T3SharePayloadLoaderError.fileTooLarge {
                            skippedOversizedFile = true
                        } catch {}
                    } else {
                        textFragments.append(urlValue.absoluteString)
                    }
                    continue
                }

                if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                   let text = try? await loadItemString(
                       from: provider,
                       typeIdentifier: UTType.plainText.identifier
                   )
                {
                    textFragments.append(text)
                }
            }
        }

        var warnings: [String] = []
        if skippedOversizedImage {
            warnings.append("One shared image exceeded the 10 MB attachment limit.")
        }
        if skippedOversizedFile {
            warnings.append("One shared file exceeded the 50 MB attachment limit.")
        }
        if skippedExcessAttachment {
            warnings.append(
                "Only the first \(T3IncomingShareStore.maximumAttachmentCount) shared files were attached."
            )
        }
        return T3LoadedSharePayload(
            textFragments: textFragments,
            images: images,
            files: files,
            warnings: warnings
        )
    }

    @MainActor
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
                    continuation.resume(returning: try stageFile(
                        from: url,
                        maximumBytes: T3IncomingShareStore.maximumImageBytes,
                        oversizedError: .imageTooLarge
                    ))
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    /// The provider-owned URL expires when its callback returns. Stream it to
    /// an extension-owned temporary file while enforcing the byte limit, so a
    /// malicious or enormous provider never has to be materialized in memory.
    @MainActor
    private static func loadStagedFile(
        from provider: NSItemProvider,
        typeIdentifier: String,
        maximumBytes: Int
    ) async throws -> (url: URL, byteCount: Int) {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { url, error in
                do {
                    guard let url else { throw error ?? CocoaError(.fileReadUnknown) }
                    continuation.resume(returning: try stageFile(
                        from: url,
                        maximumBytes: maximumBytes
                    ))
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    private static func stageFile(
        from sourceURL: URL,
        maximumBytes: Int,
        oversizedError: T3SharePayloadLoaderError = .fileTooLarge
    ) throws -> (url: URL, byteCount: Int) {
        let values = try sourceURL.resourceValues(forKeys: [.isRegularFileKey])
        guard sourceURL.isFileURL, values.isRegularFile == true else {
            throw CocoaError(.fileReadUnsupportedScheme)
        }
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
                    throw oversizedError
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

    @MainActor
    private static func loadURLItem(
        from provider: NSItemProvider,
        typeIdentifier: String
    ) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadItem(forTypeIdentifier: typeIdentifier) { value, error in
                if let value, let url = url(from: value) {
                    continuation.resume(returning: url)
                } else {
                    continuation.resume(throwing: error ?? CocoaError(.fileReadUnknown))
                }
            }
        }
    }

    @MainActor
    private static func loadItemString(
        from provider: NSItemProvider,
        typeIdentifier: String
    ) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadItem(forTypeIdentifier: typeIdentifier) { value, error in
                if let value,
                   let text = textString(from: value) {
                    continuation.resume(returning: text)
                } else {
                    continuation.resume(throwing: error ?? CocoaError(.fileReadUnknown))
                }
            }
        }
    }

    private static func url(from value: NSSecureCoding) -> URL? {
        if let url = value as? URL {
            return url
        }
        if let text = value as? String, let url = URL(string: text) {
            return url
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
    case fileTooLarge
}
