// Display-only path shortening for agent-log UI. Full paths stay in the model;
// views call this when rendering tool file paths so the timeline stays readable.

import Foundation

public enum PathDisplay {
    /// Shortens `path` for chrome: relative to `projectRoot` when possible,
    /// otherwise the last two path components. Non-absolute / already-short
    /// strings pass through unchanged.
    public static func short(_ path: String, projectRoot: String?) -> String {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return path }

        if let root = projectRoot.map({ $0.trimmingCharacters(in: .whitespacesAndNewlines) }),
            !root.isEmpty
        {
            let normalizedRoot = root.hasSuffix("/") ? String(root.dropLast()) : root
            if trimmed == normalizedRoot {
                return (trimmed as NSString).lastPathComponent
            }
            let prefix = normalizedRoot + "/"
            if trimmed.hasPrefix(prefix) {
                let relative = String(trimmed.dropFirst(prefix.count))
                return relative.isEmpty
                    ? (trimmed as NSString).lastPathComponent
                    : relative
            }
        }

        // Relative and other non-absolute paths are already UI-friendly.
        if !trimmed.hasPrefix("/") {
            return trimmed
        }

        let components = (trimmed as NSString).pathComponents.filter { $0 != "/" }
        switch components.count {
        case 0:
            return trimmed
        case 1:
            return components[0]
        default:
            return components.suffix(2).joined(separator: "/")
        }
    }
}
