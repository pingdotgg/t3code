import Foundation

/// Resolves transcript destinations to paths accepted by the workspace file APIs.
/// The server expects workspace-relative paths, so absolute destinations must remain
/// inside the active workspace and relative destinations must not escape it.
public struct FeatureWorkspaceFileLink: Identifiable, Sendable, Equatable, Hashable {
    private static let conventionalFileNames: Set<String> = [
        "AUTHORS", "Brewfile", "BUILD", "Caddyfile", "CHANGELOG", "CODEOWNERS",
        "Containerfile", "CONTRIBUTORS", "COPYING", "Dockerfile", "Fastfile",
        "Gemfile", "GNUmakefile", "Jenkinsfile", "Justfile", "LICENSE", "LICENCE",
        "Makefile", "NOTICE", "Podfile", "Procfile", "README", "Rakefile",
        "Vagrantfile", "WORKSPACE", "justfile", "makefile",
    ]

    private static let positionedPathExtensions: Set<String> = [
        "c", "cc", "conf", "cpp", "cs", "css", "csv", "env", "go", "h", "hpp",
        "html", "ini", "java", "js", "json", "jsx", "kt", "kts", "m", "md",
        "mdx", "mm", "php", "plist", "py", "rb", "rs", "scss", "sh", "sql",
        "swift", "text", "toml", "ts", "tsx", "txt", "vue", "xml", "yaml",
        "yml", "zsh",
    ]

    public let path: String
    public var id: String { path }

    public var entry: FeatureFileEntry {
        FeatureFileEntry(
            path: path,
            name: URL(fileURLWithPath: path).lastPathComponent,
            kind: .file
        )
    }

    public init?(url: URL, workspaceRoot: String?, relativeTo basePath: String? = nil) {
        guard let workspaceRoot, !workspaceRoot.isEmpty,
              url.host == nil, url.user == nil, url.password == nil, url.port == nil else {
            return nil
        }

        let destination: ParsedDestination
        switch url.scheme?.lowercased() {
        case nil:
            destination = Self.parsePosition(from: url.path)
        case "file":
            destination = Self.parsePosition(from: url.path)
        default:
            guard let positioned = Self.positionedRelativeDestination(from: url) else {
                return nil
            }
            destination = positioned
        }

        guard !destination.path.isEmpty,
              !destination.path.contains(":"),
              !destination.path.unicodeScalars.contains(where: { $0.value == 0 }) else {
            return nil
        }

        if !destination.path.hasPrefix("/"), !Self.isRecognizableFilePath(destination.path) {
            return nil
        }

        let root = (workspaceRoot as NSString).standardizingPath
        let base: String
        if let basePath, !basePath.isEmpty {
            base = ((root as NSString).appendingPathComponent(basePath) as NSString)
                .standardizingPath
            guard Self.contains(base, in: root) else { return nil }
        } else {
            base = root
        }
        let absolute: String
        if destination.path.hasPrefix("/") {
            absolute = (destination.path as NSString).standardizingPath
        } else {
            absolute = ((base as NSString).appendingPathComponent(destination.path) as NSString)
                .standardizingPath
        }

        guard let relative = Self.relativePath(for: absolute, in: root) else { return nil }
        path = relative
    }

    public static func isWorkspaceDestination(_ url: URL) -> Bool {
        guard url.host == nil, url.user == nil, url.password == nil, url.port == nil else {
            return false
        }
        if url.scheme?.lowercased() == "file" { return true }
        if url.scheme == nil {
            return url.path.hasPrefix("/")
                || isRecognizableFilePath(parsePosition(from: url.path).path)
        }
        return positionedRelativeDestination(from: url) != nil
    }

    private struct ParsedDestination {
        var path: String
        var line: Int?
        var column: Int?
    }

    private static func positionedRelativeDestination(from url: URL) -> ParsedDestination? {
        let raw = url.absoluteString
            .split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false)[0]
            .split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)[0]
        let decoded = String(raw).removingPercentEncoding ?? String(raw)
        let destination = parsePosition(from: decoded)
        guard destination.line != nil, isRecognizableFilePath(destination.path) else { return nil }
        return destination
    }

    private static func parsePosition(from rawPath: String) -> ParsedDestination {
        var path = rawPath
        var trailingNumbers: [Int] = []
        while trailingNumbers.count < 2, let separator = path.lastIndex(of: ":") {
            let suffix = path[path.index(after: separator)...]
            guard !suffix.isEmpty, suffix.allSatisfy(\.isNumber), let value = Int(suffix) else {
                break
            }
            trailingNumbers.append(value)
            path.removeSubrange(separator...)
        }
        return ParsedDestination(
            path: path,
            line: trailingNumbers.last,
            column: trailingNumbers.count == 2 ? trailingNumbers.first : nil
        )
    }

    private static func isRecognizableFilePath(_ path: String) -> Bool {
        let name = (path as NSString).lastPathComponent
        if conventionalFileNames.contains(name) { return true }
        let fileExtension = (name as NSString).pathExtension.lowercased()
        return positionedPathExtensions.contains(fileExtension)
    }

    private static func relativePath(for absolutePath: String, in root: String) -> String? {
        guard absolutePath != root else { return nil }
        let prefix = root == "/" ? root : root + "/"
        guard absolutePath.hasPrefix(prefix) else { return nil }
        let relative = String(absolutePath.dropFirst(prefix.count))
        guard !relative.isEmpty, relative != ".", !relative.hasPrefix("../") else { return nil }
        return relative
    }

    private static func contains(_ absolutePath: String, in root: String) -> Bool {
        absolutePath == root || absolutePath.hasPrefix(root == "/" ? root : root + "/")
    }
}
