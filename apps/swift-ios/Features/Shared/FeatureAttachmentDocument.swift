import Foundation

/// Captured files are classified from their recorded MIME type before their name.
enum FeatureAttachmentContentKind: Equatable, Sendable {
    case image, video, audio, pdf, html, markdown, text, native

    static func infer(name: String, mimeType: String? = nil) -> Self {
        let mime = normalizedMIME(mimeType)
        switch mime {
        case "application/pdf": return .pdf
        case "text/html": return .html
        case "text/markdown", "text/x-markdown": return .markdown
        default: break
        }
        if mime.hasPrefix("image/") { return .image }
        if mime.hasPrefix("video/") { return .video }
        if mime.hasPrefix("audio/") { return .audio }
        if genericMIMEs.contains(mime) {
            let ext = (name as NSString).pathExtension.lowercased()
            if ext == "pdf" { return .pdf }
            if ["htm", "html"].contains(ext) { return .html }
            if ["md", "markdown", "mdown", "mkd", "mdx"].contains(ext) { return .markdown }
            if imageExtensions.contains(ext) { return .image }
            if videoExtensions.contains(ext) { return .video }
            if audioExtensions.contains(ext) { return .audio }
            if textExtensions.contains(ext) { return .text }
            let basename = name.replacingOccurrences(of: "\\", with: "/")
                .split(separator: "/").last.map(String.init)?.lowercased() ?? ""
            if textNames.contains(where: { basename == $0 || basename.hasPrefix("\($0).") }) {
                return .text
            }
        }
        if mime.hasPrefix("text/") || textMIMEs.contains(mime)
            || (mime.hasPrefix("application/") && (mime.hasSuffix("+json") || mime.hasSuffix("+xml"))) {
            return .text
        }
        return .native
    }

    static func delimiter(name: String, mimeType: String?) -> Unicode.Scalar? {
        let mime = normalizedMIME(mimeType)
        if mime == "text/csv" { return "," }
        if mime == "text/tab-separated-values" { return "\t" }
        guard genericMIMEs.contains(mime) else { return nil }
        switch (name as NSString).pathExtension.lowercased() {
        case "csv": return ","
        case "tsv": return "\t"
        default: return nil
        }
    }

    static func sourceLanguage(name: String) -> String {
        let ext = (name as NSString).pathExtension.lowercased()
        switch ext {
        case "ts", "tsx", "mts", "cts": return "typescript"
        case "js", "jsx", "mjs", "cjs": return "javascript"
        case "py", "pyi": return "python"
        case "rs": return "rust"
        case "rb": return "ruby"
        case "sh", "bash", "zsh", "fish": return "shell"
        case "yml": return "yaml"
        case "jsonc", "jsonl", "ndjson": return "json"
        case "htm": return "html"
        case "txt", "log", "md", "markdown", "mdown", "mkd", "mdx", "csv", "tsv", "": return "plain"
        default: return ext
        }
    }

    private static func normalizedMIME(_ value: String?) -> String {
        value?.split(separator: ";", maxSplits: 1).first?
            .trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    }

    static let videoExtensions: Set<String> = ["avi", "m4v", "mkv", "mov", "mp4", "ogv", "webm", "mpeg", "mpg"]
    private static let imageExtensions: Set<String> = ["avif", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"]
    private static let audioExtensions: Set<String> = ["mp3", "wav", "ogg", "oga", "flac", "aac", "m4a", "opus", "aiff"]
    private static let genericMIMEs: Set<String> = ["", "application/octet-stream", "text/plain"]
    private static let textMIMEs: Set<String> = [
        "application/json", "application/xml", "application/javascript", "application/x-javascript",
        "application/yaml", "application/x-yaml", "application/toml", "application/sql",
    ]
    private static let textNames = [
        "dockerfile", "makefile", "gemfile", "rakefile", "license", "readme",
        ".gitignore", ".gitattributes", ".editorconfig", ".env",
    ]
    private static let textExtensions: Set<String> = [
        "txt", "log", "json", "jsonc", "jsonl", "ndjson", "yaml", "yml", "toml", "ini", "conf",
        "config", "env", "csv", "tsv", "xml", "css", "scss", "sass", "less", "js", "jsx", "mjs",
        "cjs", "ts", "tsx", "mts", "cts", "py", "pyi", "rb", "go", "rs", "swift", "kt", "kts",
        "java", "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "fish", "sql",
        "graphql", "gql", "vue", "svelte", "r", "lua", "ex", "exs", "erl", "hs", "clj", "dart",
        "diff", "patch", "lock", "properties", "gradle",
    ]
}

struct FeatureDelimitedPreview: Equatable, Sendable {
    let rows: [[String]]
    let isTruncated: Bool

    /// Bounds the rendered table independently of the source text limit.
    init(text: String, delimiter: Unicode.Scalar) {
        let characters = Array(text.unicodeScalars)
        var rows: [[String]] = []
        var row: [String] = []
        var cell = String.UnicodeScalarView()
        var cellLength = 0
        var quoted = false
        var truncated = false
        var index = characters.first == "\u{feff}" ? 1 : 0
        var rowStart = index
        func endCell() {
            if row.count < 30 { row.append(String(cell)) } else { truncated = true }
            cell = String.UnicodeScalarView()
            cellLength = 0
        }
        func append(_ character: Unicode.Scalar) {
            if cellLength < 2_000 {
                cell.append(character)
                cellLength += 1
            } else { truncated = true }
        }
        while index < characters.count {
            let character = characters[index]
            if character == "\"" {
                if quoted, index + 1 < characters.count, characters[index + 1] == "\"" {
                    append("\"")
                    index += 2
                    continue
                }
                if quoted || cell.isEmpty {
                    quoted.toggle()
                    index += 1
                    continue
                }
            }
            if !quoted, character == delimiter || character == "\n" || character == "\r" {
                endCell()
                if character != delimiter {
                    rows.append(row)
                    row = []
                    if character == "\r", index + 1 < characters.count, characters[index + 1] == "\n" {
                        index += 1
                    }
                    rowStart = index + 1
                    if rows.count == 100 {
                        self.rows = rows
                        isTruncated = truncated || index < characters.count - 1
                        return
                    }
                }
            } else {
                append(character)
            }
            index += 1
        }
        if rowStart < characters.count {
            endCell()
            rows.append(row)
        }
        self.rows = rows
        isTruncated = truncated || quoted
    }
}

enum FeatureAttachmentTextError: LocalizedError {
    case binary, invalidUTF8

    var errorDescription: String? {
        switch self {
        case .binary: "This file contains binary data. Open it in another app."
        case .invalidUTF8: "This file is not UTF-8 text. Open it in another app."
        }
    }
}

struct FeatureAttachmentText: Equatable, Sendable {
    static let maximumBytes = 1_024 * 1_024
    let text: String
    let isTruncated: Bool

    static func decode(_ bytes: Data, truncated: Bool = false) throws -> Self {
        var prefix = Data(bytes.prefix(maximumBytes))
        let isTruncated = truncated || bytes.count > maximumBytes
        guard !prefix.contains(0) else { throw FeatureAttachmentTextError.binary }
        // A bounded UTF-8 read may end halfway through a scalar. Remove only a valid
        // incomplete suffix; malformed bytes inside the captured prefix remain errors.
        if isTruncated, let lastStart = prefix.lastIndex(where: { $0 & 0xc0 != 0x80 }) {
            let suffix = Array(prefix[lastStart...])
            let lead = suffix[0]
            let expected = (0xc2...0xdf).contains(lead) ? 2
                : (0xe0...0xef).contains(lead) ? 3
                : (0xf0...0xf4).contains(lead) ? 4 : 0
            if expected > suffix.count, suffix.dropFirst().allSatisfy({ $0 & 0xc0 == 0x80 }),
               suffix.count < 2 || (lead != 0xe0 || suffix[1] >= 0xa0)
                && (lead != 0xed || suffix[1] < 0xa0)
                && (lead != 0xf0 || suffix[1] >= 0x90)
                && (lead != 0xf4 || suffix[1] < 0x90) {
                prefix.removeSubrange(lastStart...)
            }
        }
        guard let text = String(data: prefix, encoding: .utf8) else {
            throw FeatureAttachmentTextError.invalidUTF8
        }
        return Self(text: text, isTruncated: isTruncated)
    }

    /// Reads only the preview prefix even when the host ignores the Range header.
    static func read(_ url: URL) async throws -> Self {
        if url.isFileURL {
            return try await Task.detached(priority: .userInitiated) {
                let handle = try FileHandle(forReadingFrom: url)
                defer { try? handle.close() }
                return try decode(handle.read(upToCount: maximumBytes + 1) ?? Data())
            }.value
        }
        guard ["http", "https"].contains(url.scheme?.lowercased() ?? "") else {
            throw FeatureMediaPreviewError.invalidResponse
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: url, timeoutInterval: 30)
        request.setValue("bytes=0-\(maximumBytes)", forHTTPHeaderField: "Range")
        let (stream, response) = try await session.bytes(for: request)
        guard let response = response as? HTTPURLResponse else {
            throw FeatureMediaPreviewError.invalidResponse
        }
        guard (200...299).contains(response.statusCode) else {
            throw FeatureMediaPreviewError.httpStatus(response.statusCode)
        }
        var bytes = Data()
        bytes.reserveCapacity(maximumBytes + 1)
        for try await byte in stream {
            bytes.append(byte)
            if bytes.count > maximumBytes { break }
        }
        try Task.checkCancellation()
        return try decode(bytes)
    }
}
