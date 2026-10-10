import Testing
@testable import T3Code

struct FeatureDiffHydrationTests {
    private let patch = [
        FeatureDiffLine(id: "patch-1", kind: .deletion, oldLine: 2, text: "let color = blue"),
        FeatureDiffLine(id: "patch-2", kind: .addition, newLine: 2, text: "let color = green"),
    ]
    private let full = [
        FeatureDiffLine(id: "full-1", kind: .context, oldLine: 1, newLine: 1, text: "import SwiftUI"),
        FeatureDiffLine(id: "full-2", kind: .deletion, oldLine: 2, text: "let color = blue"),
        FeatureDiffLine(id: "full-3", kind: .addition, newLine: 2, text: "let color = green"),
    ]

    @Test
    func failedLoadKeepsPatchLinesUntilRetrySucceeds() {
        var hydration = FeatureDiffHydration(lines: patch)

        let failed = hydration.begin()
        hydration.fail(failed, message: "The network connection was lost.")

        #expect(hydration.lines == patch)
        #expect(hydration.errorMessage == "The network connection was lost.")
        #expect(!hydration.isLoading)

        let retry = hydration.begin()
        #expect(hydration.errorMessage == nil)
        #expect(hydration.isLoading)

        hydration.succeed(retry, lines: full)

        #expect(hydration.lines == full)
        #expect(hydration.errorMessage == nil)
        #expect(!hydration.isLoading)
    }

    @Test
    func failedLoadWithoutPatchLinesReportsTheError() {
        var hydration = FeatureDiffHydration(lines: [])

        let failed = hydration.begin()
        hydration.fail(failed, message: "Request timed out.")

        #expect(hydration.lines.isEmpty)
        #expect(hydration.errorMessage == "Request timed out.")
        #expect(!hydration.isLoading)
    }

    @Test
    func supersededAttemptCannotOverwriteNewerResult() {
        var hydration = FeatureDiffHydration(lines: patch)

        let stale = hydration.begin()
        let current = hydration.begin()
        hydration.succeed(current, lines: full)
        hydration.fail(stale, message: "The request was cancelled.")
        hydration.succeed(stale, lines: [])

        #expect(hydration.lines == full)
        #expect(hydration.errorMessage == nil)
        #expect(!hydration.isLoading)
    }

    @Test
    func missingFullContentsKeepPatchLinesWithoutError() {
        var hydration = FeatureDiffHydration(lines: patch)

        let attempt = hydration.begin()
        hydration.succeed(attempt, lines: nil)

        #expect(hydration.lines == patch)
        #expect(hydration.errorMessage == nil)
        #expect(!hydration.isLoading)
    }
}
