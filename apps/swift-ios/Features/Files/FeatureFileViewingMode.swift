import Foundation

enum FeatureFileViewingMode: Hashable {
    case preview
    case source

    static func initial(kind: FeatureFilePreviewKind, line: Int?) -> Self {
        if kind == .source || kind == .plainText { return .source }
        if kind.hasTextSource, let line, line > 0 { return .source }
        return .preview
    }

    static func sourceLine(_ requested: Int?, lineCount: Int) -> Int? {
        guard let requested, requested > 0, lineCount > 0 else { return nil }
        return min(requested, lineCount)
    }
}

struct FeatureFileLoadIdentity: Hashable {
    let threadID: String
    let workspaceRoot: String?
    let path: String
    let mode: FeatureFileViewingMode
    let refreshVersion: Int
}

enum FeatureWorkspacePreviewPolicy {
    /// These formats have native viewers, but neither host asset route serves them.
    /// Captured attachments have their own URLs and do not use this policy.
    static func supportsPreview(path: String) -> Bool {
        guard FeatureFilePreviewKind.infer(path: path) != .document else { return false }
        let fileExtension = URL(fileURLWithPath: path).pathExtension.lowercased()
        return !["aif", "mpeg", "mpg"].contains(fileExtension)
    }
}

extension FeatureFilePreviewKind {
    var opensLinkedMediaPreview: Bool {
        switch self {
        case .image, .pdf, .video, .audio, .browser: true
        case .document, .markdown, .source, .plainText: false
        }
    }

    var hasTextSource: Bool {
        switch self {
        case .source, .plainText, .markdown, .browser: true
        case .image, .pdf, .video, .audio, .document: false
        }
    }
}

extension FeatureWorkspaceAssetResolving {
    /// Workspace pages need a scoped URL so relative styles, scripts and images work.
    /// Audio/video and files outside the workspace keep the exact-file media route.
    func previewAssetURL(
        threadID: String, path: String, kind: FeatureFilePreviewKind,
        workspaceRoot: String? = nil
    ) async throws -> URL {
        guard FeatureWorkspacePreviewPolicy.supportsPreview(path: path) else {
            throw FeatureCapabilityUnavailable("Workspace preview for this file type")
        }
        if kind != .video, kind != .audio,
           let relativePath = FeatureWorkspacePreviewPath.relativePath(path, workspaceRoot: workspaceRoot) {
            return try await workspaceAssetURL(threadID: threadID, path: relativePath)
        }
        return try await mediaAssetURL(threadID: threadID, path: path)
    }
}

enum FeatureWorkspacePreviewPath {
    /// Transcript media paths are already decoded host paths, not URLs.
    static func relativePath(_ path: String, workspaceRoot: String?) -> String? {
        let normalized = path.replacingOccurrences(of: "\\", with: "/")
        guard !normalized.hasPrefix("~/") else { return nil }
        let isWindows = normalized.range(of: #"^[A-Za-z]:/"#, options: .regularExpression) != nil
            || normalized.hasPrefix("//")
        var relative = normalized
        if normalized.hasPrefix("/") || isWindows {
            guard let workspaceRoot, !workspaceRoot.isEmpty else { return nil }
            let root = workspaceRoot.replacingOccurrences(of: "\\", with: "/")
                .replacingOccurrences(of: #"/+$"#, with: "", options: .regularExpression)
            let prefix = root + "/"
            guard (isWindows ? normalized.lowercased() : normalized)
                .hasPrefix(isWindows ? prefix.lowercased() : prefix) else { return nil }
            relative = String(normalized.dropFirst(prefix.count))
            // A path with the right prefix can still escape the workspace.
            guard !relative.split(separator: "/").contains("..") else { return nil }
        }
        var segments: [Substring] = []
        for segment in relative.split(separator: "/") {
            if segment == "." { continue }
            if segment == ".." {
                guard !segments.isEmpty else { return nil }
                segments.removeLast()
            } else {
                segments.append(segment)
            }
        }
        return segments.isEmpty ? nil : segments.joined(separator: "/")
    }
}
