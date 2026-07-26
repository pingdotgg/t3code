#if DEBUG
    import SwiftUI

    /// Last reported scroll geometry of the chat header's git strip, so probe
    /// runs can check where the strip actually landed. The strip's placement
    /// cannot be read from a probe screenshot with any precision, and SwiftUI
    /// scroll views cannot be hosted in the CLT test bundle, so this is the
    /// only way to assert the trailing placement at runtime.
    @MainActor
    enum UIProbeGitStrip {
        private(set) static var latest: ChatHeaderView.GitStripMetrics?
        private(set) static var latestThreadID: String?

        static func record(_ metrics: ChatHeaderView.GitStripMetrics, threadID: String) {
            latest = metrics
            latestThreadID = threadID
        }

        /// Drops the cached reading. Probe checks call this before the state
        /// they are about to measure changes, so a strip that never reports
        /// fresh geometry reads as "no geometry" instead of silently passing on
        /// the previous thread's numbers.
        static func reset() {
            latest = nil
            latestThreadID = nil
        }

        /// The current reading, but only when it came from `threadID`. A stale
        /// reading from another thread is not evidence about this one.
        static func metrics(for threadID: String) -> ChatHeaderView.GitStripMetrics? {
            guard latestThreadID == threadID else { return nil }
            return latest
        }

        /// One-line summary for probe logs: overflow, offset, and whether the
        /// strip is sitting at its trailing edge.
        static func describe() -> String {
            guard let latest else { return "git-strip: no geometry reported" }
            return "git-strip thread=\(latestThreadID ?? "nil") "
                + "content=\(Int(latest.contentWidth)) "
                + "container=\(Int(latest.containerWidth)) "
                + "offset=\(Int(latest.contentOffsetX)) "
                + "overflowing=\(latest.overflow.isOverflowing) "
                + "atTrailingEdge=\(latest.isAtTrailingEdge)"
        }
    }
#endif
