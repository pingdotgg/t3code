import XCTest
@testable import T3Code

final class ServerSharedPreferencesTests: XCTestCase {
    func testRestartContinuationDefaultsToOffOnOlderServers() throws {
        let settings = try JSONDecoder.t3.decode(ServerSettingsSnapshot.self, from: Data("{}".utf8))
        let capabilities = try JSONDecoder.t3.decode(
            EnvironmentDescriptor.Capabilities.self,
            from: Data("{}".utf8)
        )

        XCTAssertFalse(settings.continueThreadsAfterServerUpdate)
        XCTAssertFalse(ServerSettingsSnapshot().continueThreadsAfterServerUpdate)
        XCTAssertNil(capabilities.threadRestartContinuation)
        XCTAssertNil(capabilities.usageLimitSources)
    }

    func testRestartContinuationDecodesAndRetainsItsSavedValue() throws {
        for enabled in [true, false] {
            let settings = try JSONValue.object([
                "continueThreadsAfterServerUpdate": .bool(enabled),
            ]).decode(ServerSettingsSnapshot.self)
            let capabilities = try JSONValue.object([
                "threadRestartContinuation": .bool(enabled),
                "usageLimitSources": .bool(enabled),
            ]).decode(EnvironmentDescriptor.Capabilities.self)

            XCTAssertEqual(settings.continueThreadsAfterServerUpdate, enabled)
            XCTAssertEqual(capabilities.threadRestartContinuation, enabled)
            XCTAssertEqual(capabilities.usageLimitSources, enabled)
            let encoded = try JSONValue.encode(settings)
            XCTAssertEqual(encoded["continueThreadsAfterServerUpdate"], .bool(enabled))
        }
    }

    func testSharedPatchIncludesRestartContinuationOnlyWhenSupported() {
        let settings = ServerSettingsSnapshot(continueThreadsAfterServerUpdate: true)
        let legacyPatch = settings.sharedPatch(supportsRestartContinuation: false)
        let supportedPatch = settings.sharedPatch(supportsRestartContinuation: true)

        XCTAssertNil(legacyPatch["continueThreadsAfterServerUpdate"])
        XCTAssertEqual(settings.sharedPatch, legacyPatch)
        XCTAssertEqual(supportedPatch["continueThreadsAfterServerUpdate"], .bool(true))
        XCTAssertEqual(supportedPatch["defaultThreadEnvMode"], legacyPatch["defaultThreadEnvMode"])
        XCTAssertEqual(supportedPatch["sidebarAutoSettleOnMerge"], legacyPatch["sidebarAutoSettleOnMerge"])
        XCTAssertEqual(
            ServerSettingsChange.continueThreadsAfterServerUpdate(false).jsonValue,
            .object(["continueThreadsAfterServerUpdate": .bool(false)])
        )
    }

    func testRestartPreferenceDoesNotCauseMismatchesForUnsupportedTargets() {
        let source = ServerSettingsSnapshot(continueThreadsAfterServerUpdate: true)
        let target = ServerSettingsSnapshot(continueThreadsAfterServerUpdate: false)

        XCTAssertEqual(
            source.sharedPatch(supportsRestartContinuation: false),
            target.sharedPatch(supportsRestartContinuation: false)
        )
        XCTAssertNotEqual(
            source.sharedPatch(supportsRestartContinuation: true),
            target.sharedPatch(supportsRestartContinuation: true)
        )
    }
}
