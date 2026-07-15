import Foundation

/// Thresholds for work that is useful only while the caret is near a token.
/// Keeping this policy separate makes the large-paste benchmark explicit and
/// prevents suggestion parsing from becoming a second full-document pass.
public enum ComposerPerformancePolicy {
    /// A 1 MiB paste is the benchmark payload for SER-87. The lower threshold
    /// leaves headroom on older Macs before the editor starts feeling heavy.
    public static let largeDraftThreshold = 256 * 1024

    public static func shouldDeferSuggestions(for text: String) -> Bool {
        text.utf8.index(
            text.utf8.startIndex,
            offsetBy: largeDraftThreshold,
            limitedBy: text.utf8.endIndex
        ) != nil
    }
}
