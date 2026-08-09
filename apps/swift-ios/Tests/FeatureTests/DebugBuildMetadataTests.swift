import Foundation
import Testing
@testable import T3Code

@Suite("Debug build metadata")
struct DebugBuildMetadataTests {
    @Test
    func presentsCompletePublicBuildDistance() {
        let metadata = DebugBuildMetadata(info: [
            "CFBundleVersion": "456",
            "T3GitCommit": "abc123-dirty",
            "T3GitRepoURL": "https://github.com/pingdotgg/t3code",
            "T3GitBaseRef": "upstream/t3code/rebuild-mobile-app-swift",
            "T3GitAheadCount": "2",
            "T3GitBehindCount": "3",
        ])

        #expect(metadata.identityLabel == "456 · abc123-dirty")
        #expect(metadata.distanceLabel == "2↑ 3↓ rebuild-mobile-app-swift")
        #expect(
            metadata.accessibilityLabel
                == "Development build 456 · abc123-dirty, compared with upstream/t3code/rebuild-mobile-app-swift: 2 commits ahead and 3 commits behind"
        )
        #expect(
            metadata.commitURL?.absoluteString
                == "https://github.com/pingdotgg/t3code/commit/abc123"
        )
    }

    @Test
    func omitsInvalidOrIncompleteMetadata() {
        let metadata = DebugBuildMetadata(info: [
            "T3GitRepoURL": "https://private.example/repo",
            "T3GitAheadCount": "-1",
            "T3GitBehindCount": "not-a-number",
        ])

        #expect(metadata.identityLabel == "? · unknown")
        #expect(metadata.distanceLabel == nil)
        #expect(metadata.commitURL == nil)
        #expect(metadata.accessibilityLabel == "Development build ? · unknown")
    }

    @Test
    func describesSingularDistance() {
        let metadata = DebugBuildMetadata(info: [
            "T3GitBaseRef": "upstream/main",
            "T3GitAheadCount": "1",
            "T3GitBehindCount": "1",
        ])

        #expect(
            metadata.accessibilityLabel
                == "Development build ? · unknown, compared with upstream/main: 1 commit ahead and 1 commit behind"
        )
    }

    @Test
    func ignoresUnexpandedBuildSettingsAndIncompleteDistance() {
        let metadata = DebugBuildMetadata(info: [
            "CFBundleVersion": "$(CURRENT_PROJECT_VERSION)",
            "T3GitCommit": "abc123",
            "T3GitRepoURL": "https://github.com/pingdotgg/t3code",
            "T3GitBaseRef": "upstream/main",
            "T3GitAheadCount": "1",
        ])

        #expect(metadata.identityLabel == "? · abc123")
        #expect(metadata.distanceLabel == nil)
        #expect(
            metadata.commitURL?.absoluteString
                == "https://github.com/pingdotgg/t3code/commit/abc123"
        )
    }
}
