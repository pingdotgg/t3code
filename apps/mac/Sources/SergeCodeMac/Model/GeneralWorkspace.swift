import Foundation

/// Fixed host-local workspace used for Quick Chat (SER-139): general threads
/// that are not attached to a coding project folder the user picked.
public enum GeneralWorkspace: Sendable {
    /// Tilde form stored in docs and settings-facing copy.
    public static let relativePath = "~/Documents/SergeCode/General"
    public static let projectTitle = "General"

    /// Absolute path with `~` expanded for this process's home directory.
    public static var resolvedPath: String {
        normalize(relativePath)
    }

    /// Expand `~`, standardize, and drop trailing slashes so path equality
    /// is stable across typed paths, open-panel URLs, and server snapshots.
    public static func normalize(_ path: String) -> String {
        var expanded = (path as NSString).expandingTildeInPath
        while expanded.count > 1, expanded.hasSuffix("/") {
            expanded.removeLast()
        }
        return (expanded as NSString).standardizingPath
    }

    public static func pathsMatch(_ lhs: String, _ rhs: String) -> Bool {
        normalize(lhs) == normalize(rhs)
    }

    public static func isGeneralProjectPath(_ path: String) -> Bool {
        pathsMatch(path, relativePath)
    }
}
