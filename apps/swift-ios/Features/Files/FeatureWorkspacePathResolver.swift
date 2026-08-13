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

    static func resolvedWorkspaceRoot(worktreePath: String?, projectPath: String?) -> String? {
        if let worktreePath = Self.nonBlank(worktreePath) {
            return worktreePath
        }
        return Self.nonBlank(projectPath)
    }

    public init?(url: URL, workspaceRoot: String?) {
        guard let workspaceRoot = Self.nonBlank(workspaceRoot),
              url.host == nil, url.user == nil, url.password == nil, url.port == nil else {
            return nil
        }

        let usesWindowsPaths = Self.windowsAbsolutePath(workspaceRoot) != nil
        var destination: ParsedDestination
        if usesWindowsPaths,
           let positioned = Self.positionedWindowsAbsoluteDestination(from: url) {
            destination = positioned
        } else {
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
        }
        if usesWindowsPaths {
            destination.path = destination.path.replacingOccurrences(of: "\\", with: "/")
        }

        guard !destination.path.isEmpty,
              !Self.containsDisallowedColon(destination.path, usesWindowsPaths: usesWindowsPaths),
              !destination.path.unicodeScalars.contains(where: { $0.value == 0 }) else {
            return nil
        }

        if !destination.path.hasPrefix("/"), !destination.path.contains("/"),
           !Self.isRecognizableFilePath(destination.path) {
            return nil
        }

        if usesWindowsPaths {
            guard let relative = Self.windowsRelativePath(
                for: destination.path,
                in: workspaceRoot
            ) else {
                return nil
            }
            path = relative
            return
        }

        let root = (workspaceRoot as NSString).standardizingPath
        let absolute: String
        if destination.path.hasPrefix("/") {
            absolute = (destination.path as NSString).standardizingPath
        } else {
            absolute = ((root as NSString).appendingPathComponent(destination.path) as NSString)
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
        if positionedWindowsAbsoluteDestination(from: url) != nil { return true }
        if url.scheme == nil {
            return url.path.hasPrefix("/")
                || url.path.contains("/")
                || isRecognizableFilePath(parsePosition(from: url.path).path)
        }
        return positionedRelativeDestination(from: url) != nil
    }

    private struct ParsedDestination {
        var path: String
        var line: Int?
        var column: Int?
    }

    private enum WindowsRoot {
        case drive(String)
        case unc(server: String, share: String)
    }

    private struct WindowsAbsolutePath {
        var root: WindowsRoot
        var components: [String]
    }

    private static func nonBlank(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }

    private static func positionedWindowsAbsoluteDestination(from url: URL) -> ParsedDestination? {
        let raw: String
        if url.scheme?.lowercased() == "file" {
            raw = url.path
        } else {
            raw = url.absoluteString
                .split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false)[0]
                .split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)[0]
                .description
        }
        let decoded = raw.removingPercentEncoding ?? raw
        var destination = parsePosition(from: decoded)
        if destination.path.hasPrefix("/"),
           windowsAbsolutePath(String(destination.path.dropFirst())) != nil {
            destination.path.removeFirst()
        }
        guard windowsAbsolutePath(destination.path) != nil else { return nil }
        return destination
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

    private static func containsDisallowedColon(
        _ path: String,
        usesWindowsPaths: Bool
    ) -> Bool {
        guard usesWindowsPaths, windowsAbsolutePath(path) != nil else {
            return path.contains(":")
        }
        return path.dropFirst(2).contains(":")
    }

    private static func windowsRelativePath(for destination: String, in root: String) -> String? {
        guard let normalizedRoot = windowsAbsolutePath(root) else { return nil }
        let absolute: WindowsAbsolutePath
        if let normalizedDestination = windowsAbsolutePath(destination) {
            absolute = normalizedDestination
        } else {
            guard !destination.hasPrefix("/") else { return nil }
            let rootPrefix = switch normalizedRoot.root {
            case let .drive(drive): "\(drive):/"
            case let .unc(server, share): "//\(server)/\(share)/"
            }
            let rootText = rootPrefix + normalizedRoot.components.joined(separator: "/")
            guard let normalizedDestination = windowsAbsolutePath(rootText + "/" + destination) else {
                return nil
            }
            absolute = normalizedDestination
        }
        guard windowsRootsMatch(absolute.root, normalizedRoot.root),
              absolute.components.count > normalizedRoot.components.count else {
            return nil
        }
        for (rootComponent, destinationComponent) in zip(
            normalizedRoot.components,
            absolute.components
        ) where rootComponent.caseInsensitiveCompare(destinationComponent) != .orderedSame {
            return nil
        }
        return absolute.components.dropFirst(normalizedRoot.components.count).joined(separator: "/")
    }

    private static func windowsAbsolutePath(_ rawPath: String) -> WindowsAbsolutePath? {
        var path = rawPath
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\\", with: "/")
        if path.hasPrefix("/"), !path.hasPrefix("//"), path.dropFirst().dropFirst(1).first == ":" {
            path.removeFirst()
        }
        if path.hasPrefix("//") {
            let parts = path.dropFirst(2).split(separator: "/", omittingEmptySubsequences: true)
            guard parts.count >= 2 else { return nil }
            let server = String(parts[0])
            let share = String(parts[1])
            guard isValidWindowsComponent(server), isValidWindowsComponent(share) else { return nil }
            guard let components = normalizedWindowsComponents(parts.dropFirst(2)) else { return nil }
            return WindowsAbsolutePath(
                root: .unc(server: server, share: share),
                components: components
            )
        }
        let scalars = Array(path.unicodeScalars.prefix(3))
        guard scalars.count == 3,
              CharacterSet.letters.contains(scalars[0]),
              scalars[1] == ":",
              scalars[2] == "/" else {
            return nil
        }

        guard let components = normalizedWindowsComponents(
            path.dropFirst(3).split(separator: "/", omittingEmptySubsequences: true)
        ) else { return nil }
        return WindowsAbsolutePath(root: .drive(String(scalars[0])), components: components)
    }

    private static func normalizedWindowsComponents<S: Sequence>(_ raw: S) -> [String]?
    where S.Element: StringProtocol {
        var components: [String] = []
        for component in raw {
            switch component {
            case ".":
                continue
            case "..":
                guard !components.isEmpty else { return nil }
                components.removeLast()
            default:
                guard isValidWindowsComponent(component) else { return nil }
                components.append(String(component))
            }
        }
        return components
    }

    private static func isValidWindowsComponent(_ component: some StringProtocol) -> Bool {
        !component.isEmpty
            && !component.contains(":")
            && !component.unicodeScalars.contains(where: { $0.value == 0 })
    }

    private static func windowsRootsMatch(_ lhs: WindowsRoot, _ rhs: WindowsRoot) -> Bool {
        switch (lhs, rhs) {
        case let (.drive(left), .drive(right)):
            left.caseInsensitiveCompare(right) == .orderedSame
        case let (.unc(leftServer, leftShare), .unc(rightServer, rightShare)):
            leftServer.caseInsensitiveCompare(rightServer) == .orderedSame
                && leftShare.caseInsensitiveCompare(rightShare) == .orderedSame
        default:
            false
        }
    }

    private static func relativePath(for absolutePath: String, in root: String) -> String? {
        guard absolutePath != root else { return nil }
        let prefix = root == "/" ? root : root + "/"
        guard absolutePath.hasPrefix(prefix) else { return nil }
        let relative = String(absolutePath.dropFirst(prefix.count))
        guard !relative.isEmpty, relative != ".", !relative.hasPrefix("../") else { return nil }
        return relative
    }
}
