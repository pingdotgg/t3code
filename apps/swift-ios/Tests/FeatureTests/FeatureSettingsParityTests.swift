import XCTest
@testable import T3Code

final class FeatureSettingsParityTests: XCTestCase {
    func testCachedRuntimeDefaultsRemainCompatible() throws {
        let legacy = try JSONValue.object([:]).decode(FeatureEnvironmentPreferences.self)
        XCTAssertEqual(legacy.defaultRuntimeMode, .fullAccess)
        var current = legacy
        current.defaultRuntimeMode = .autoAcceptEdits
        XCTAssertEqual(try JSONValue.encode(current).decode(FeatureEnvironmentPreferences.self).defaultRuntimeMode, .autoAcceptEdits)
        var project = FeatureProject(id: "env:project", wireID: "project", environmentID: "env", name: "Project", path: "/project")
        XCTAssertNil(try JSONValue.encode(project).decode(FeatureProject.self).defaultRuntimeMode)
        project.defaultRuntimeMode = .approvalRequired
        XCTAssertEqual(try JSONValue.encode(project).decode(FeatureProject.self).defaultRuntimeMode, .approvalRequired)
    }

    func testSharedPreferencesFilterUnsupportedSettingsBeforeSending() throws {
        let oldSettings = try JSONValue.object([:]).decode(ServerSettingsSnapshot.self)
        let current = try JSONValue.object([
            "defaultRuntimeMode": .string("approval-required"),
            "branchNamingMode": .string("custom"),
            "branchNamePrefix": .string(""),
            "branchNameInstructions": .string("Include issue IDs"),
            "enableAgentBrowserAccess": .bool(false),
            "enableProviderUpdateChecks": .bool(false),
            "autoResumeLimitedThreads": .bool(true),
            "snoozeLimitedThreads": .bool(true),
        ]).decode(ServerSettingsSnapshot.self)
        let patch = ServerSettingsChange.sharedPreferences(current.sharedPatch)
        let filtered = try XCTUnwrap(NativeSharedPreferenceChange.filter(
            patch, supportsRestartContinuation: false, settings: oldSettings
        ))
        XCTAssertEqual(filtered.jsonValue, oldSettings.sharedPatch)
        XCTAssertEqual(NativeSharedPreferenceChange.filter(
            patch, supportsRestartContinuation: false, settings: current
        ), patch)

        let changes: [ServerSettingsChange] = [
            .defaultRuntimeMode(.approvalRequired), .branchNamingMode(.custom),
            .branchNamePrefix(""), .branchNameInstructions("Include issue IDs"),
            .enableAgentBrowserAccess(false), .enableProviderUpdateChecks(false),
            .autoResumeLimitedThreads(true), .snoozeLimitedThreads(true),
        ]
        for change in changes {
            XCTAssertNil(NativeSharedPreferenceChange.filter(change, supportsRestartContinuation: true, settings: oldSettings))
            XCTAssertEqual(NativeSharedPreferenceChange.filter(change, supportsRestartContinuation: true, settings: current), change)
        }
        XCTAssertEqual(filtered.jsonValue["defaultThreadEnvMode"], .null)
    }
}
