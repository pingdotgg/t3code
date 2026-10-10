import XCTest
@testable import T3Code

final class ServerSettingsParityTests: XCTestCase {
    func testWorkspaceInheritanceSurvivesMissingNullAndExplicitValues() throws {
        let inheritedValues: [[String: JSONValue]] = [[:], ["defaultThreadEnvMode": .null]]
        for fields in inheritedValues {
            let inherited = try JSONValue.object(fields).decode(ServerSettingsSnapshot.self)
            XCTAssertNil(inherited.defaultThreadEnvMode)
            XCTAssertNil(try JSONValue.encode(inherited).decode(ServerSettingsSnapshot.self).defaultThreadEnvMode)
            XCTAssertEqual(inherited.sharedPatch["defaultThreadEnvMode"], .null)
        }
        let clear = ServerSettingsChange.defaultThreadEnvMode(nil).jsonValue
        XCTAssertEqual(clear, .object(["defaultThreadEnvMode": .null]))
        for mode in [ServerThreadEnvironmentMode.local, .worktree] {
            let explicit = try ServerSettingsChange.defaultThreadEnvMode(mode).jsonValue.decode(ServerSettingsSnapshot.self)
            XCTAssertEqual(explicit.defaultThreadEnvMode, mode)
        }
    }

    func testProjectResetRestoresInheritanceInsteadOfWritingANullOverride() throws {
        var settings = try JSONValue.object([
            "projectSettingsFolded": .bool(true),
            "projectSettingsOverrides": .object([
                "project": .object([
                    "defaultThreadEnvMode": .string("local"),
                    "branchNameInstructions": .string("Keep issue IDs"),
                ]),
            ]),
        ]).decode(ServerSettingsSnapshot.self)
        XCTAssertEqual(settings.resolvingProject(id: "project").defaultThreadEnvMode, .local)
        let patch = ServerProjectSettingChange(key: .defaultThreadEnvMode, value: nil)
            .patch(projectID: "project", settings: settings).jsonValue
        let entry = try XCTUnwrap(patch["projectSettingsOverrides"]?["project"])
            .decode([String: JSONValue].self)
        XCTAssertNil(entry["defaultThreadEnvMode"])
        XCTAssertEqual(entry["branchNameInstructions"], .string("Keep issue IDs"))
        settings.projectSettingsOverrides["project"] = entry
        XCTAssertNil(settings.resolvingProject(id: "project", legacyWorkspaceMode: .worktree).defaultThreadEnvMode)
    }

    func testRuntimeDefaultsAndModelCapabilitiesDecodeAcrossServerVersions() throws {
        let legacy = try JSONValue.object([:]).decode(ServerSettingsSnapshot.self)
        XCTAssertEqual(legacy.defaultRuntimeMode, .fullAccess)
        XCTAssertFalse(legacy.supportsDefaultRuntimeMode)
        XCTAssertNil(try JSONValue.object([:]).decode(ServerModelCapabilities.self).supportedRuntimeModes)
        for mode in RuntimeMode.allCases {
            var settings = try ServerSettingsChange.defaultRuntimeMode(mode).jsonValue.decode(ServerSettingsSnapshot.self)
            XCTAssertTrue(settings.supportsDefaultRuntimeMode)
            XCTAssertEqual(settings.defaultRuntimeMode, mode)
            XCTAssertEqual(settings.resolvingProject(id: "other").defaultRuntimeMode, mode)
            settings.projectSettingsOverrides = ["project": ["defaultRuntimeMode": .string("approval-required")]]
            XCTAssertEqual(settings.resolvingProject(id: "project").defaultRuntimeMode, .approvalRequired)
        }
        let capabilities = try JSONValue.object([
            "supportedRuntimeModes": .array([.string("auto-accept-edits"), .string("full-access")]),
        ]).decode(ServerModelCapabilities.self)
        XCTAssertEqual(capabilities.supportedRuntimeModes, [.autoAcceptEdits, .fullAccess])
    }

    func testBranchAndBrowserOverridesPreserveEmptyStringsAndFalse() throws {
        var settings = try JSONValue.object([
            "branchNamingMode": .string("static"),
            "branchNamePrefix": .string("t3code"),
            "branchNameInstructions": .string("Environment instructions"),
            "enableAgentBrowserAccess": .bool(true),
            "defaultAutoPull": .bool(false),
            "projectSettingsOverrides": .object([
                "project": .object([
                    "branchNamingMode": .string("custom"),
                    "branchNamePrefix": .string(""),
                    "branchNameInstructions": .string(""),
                    "enableAgentBrowserAccess": .bool(false),
                    "defaultAutoPull": .bool(true),
                    "futureSetting": .object(["keep": .bool(true)]),
                ]),
            ]),
        ]).decode(ServerSettingsSnapshot.self)
        let effective = settings.resolvingProject(id: "project")
        XCTAssertEqual(effective.branchNamingMode, .custom)
        XCTAssertEqual(effective.branchNamePrefix, "")
        XCTAssertEqual(effective.branchNameInstructions, "")
        XCTAssertEqual(effective.enableAgentBrowserAccess, false)
        XCTAssertTrue(effective.defaultAutoPull)
        XCTAssertEqual(settings.resolvingProject(id: "other").branchNamePrefix, "t3code")
        let patch = ServerProjectSettingChange(key: .branchNamingMode, value: nil)
            .patch(projectID: "project", settings: settings).jsonValue
        settings.projectSettingsOverrides["project"] = try XCTUnwrap(patch["projectSettingsOverrides"]?["project"])
            .decode([String: JSONValue].self)
        XCTAssertEqual(settings.resolvingProject(id: "project").branchNamingMode, .static)
        XCTAssertEqual(settings.projectSettingsOverrides["project"]?["futureSetting"], .object(["keep": .bool(true)]))
    }

    func testProjectScriptSettingsKeepLegacyNullAndExplicitEmptyOverrides() throws {
        let script: JSONValue = .object([
            "id": .string("dev"), "name": .string("Dev"), "command": .string("vp run dev"),
            "icon": .string("play"), "runOnWorktreeCreate": .bool(false),
        ])
        let settings = try JSONValue.object([
            "defaultProjectScripts": .array([script]),
            "projectScriptOverrides": .object(["inherit": .null, "empty": .array([])]),
        ]).decode(ServerSettingsSnapshot.self)
        XCTAssertEqual(settings.defaultProjectScripts.map(\.command), ["vp run dev"])
        XCTAssertEqual(settings.projectScriptOverrides["inherit"], .null)
        XCTAssertEqual(settings.projectScriptOverrides["empty"], .array([]))
        let legacy = try JSONValue.object([:]).decode(ServerSettingsSnapshot.self)
        XCTAssertTrue(legacy.defaultProjectScripts.isEmpty)
        XCTAssertTrue(legacy.projectScriptOverrides.isEmpty)
    }
}

extension ServerSettingsParityTests {
    func testWorktreeDirectoryIsAnEnvironmentPathAndHistoryIsReadOnly() throws {
        let legacy = try JSONValue.object([:]).decode(ServerSettingsSnapshot.self)
        XCTAssertNil(legacy.worktreesDirectory)
        XCTAssertTrue(legacy.unsupportedPreferenceKeys.contains("worktreesDirectory"))
        let capabilities = try JSONValue.object([:]).decode(EnvironmentDescriptor.Capabilities.self)
        XCTAssertNil(capabilities.worktreesDirectory)
        XCTAssertNil(capabilities.serverBrowser)
        for path in ["", "~/worktrees", #"D:\worktrees"#] {
            let patch = ServerSettingsChange.worktreesDirectory(path).jsonValue
            XCTAssertEqual(patch, .object(["worktreesDirectory": .string(path)]))
            XCTAssertNil(patch["previousWorktreesDirectories"])
            let settings = try patch.decode(ServerSettingsSnapshot.self)
            XCTAssertEqual(settings.worktreesDirectory, path)
            XCTAssertNil(settings.sharedPatch["worktreesDirectory"])
            XCTAssertEqual(settings.resolvingProject(id: "project").worktreesDirectory, path)
        }
        let settings = try JSONValue.object([
            "worktreesDirectory": .string("/new"),
            "previousWorktreesDirectories": .array([.string("/old")]),
        ]).decode(ServerSettingsSnapshot.self)
        XCTAssertEqual(settings.previousWorktreesDirectories, ["/old"])
        XCTAssertNil(settings.sharedPatch["previousWorktreesDirectories"])
    }

    func testMergeCreditsSupportsFalseOverridesAndInheritance() throws {
        let legacy = try JSONValue.object([:]).decode(ServerSettingsSnapshot.self)
        XCTAssertNil(legacy.removeAgentCreditsOnMerge)
        XCTAssertTrue(legacy.unsupportedPreferenceKeys.contains("removeAgentCreditsOnMerge"))
        for value in [false, true] {
            let settings = try ServerSettingsChange.removeAgentCreditsOnMerge(value).jsonValue
                .decode(ServerSettingsSnapshot.self)
            XCTAssertEqual(settings.removeAgentCreditsOnMerge, value)
            XCTAssertEqual(settings.sharedPatch["removeAgentCreditsOnMerge"], .bool(value))
        }
        var settings = try JSONValue.object([
            "removeAgentCreditsOnMerge": .bool(true),
            "projectSettingsOverrides": .object([
                "project": .object([
                    "removeAgentCreditsOnMerge": .bool(false),
                    "futureSetting": .string("keep"),
                ]),
            ]),
        ]).decode(ServerSettingsSnapshot.self)
        XCTAssertEqual(settings.resolvingProject(id: "project").removeAgentCreditsOnMerge, false)
        XCTAssertEqual(settings.resolvingProject(id: "other").removeAgentCreditsOnMerge, true)
        let reset = ServerProjectSettingChange(key: .removeAgentCreditsOnMerge, value: nil)
            .patch(projectID: "project", settings: settings).jsonValue
        let entry = try XCTUnwrap(reset["projectSettingsOverrides"]?["project"]).decode([String: JSONValue].self)
        XCTAssertEqual(entry, ["futureSetting": .string("keep")])
        settings.projectSettingsOverrides["project"] = entry
        XCTAssertEqual(settings.resolvingProject(id: "project").removeAgentCreditsOnMerge, true)
    }

    func testGitHubSettingsAndNewScriptFlagsSurviveSettingsRoundTrip() throws {
        let settings = try JSONValue.object([
            "github": .object([
                "hosts": .object(["github.com": .object(["account": .string("theo")])]),
                "tokens": .object(["github.example.com": .string("<redacted>")]),
            ]),
            "defaultProjectScripts": .array([.object([
                "id": .string("cleanup"), "name": .string("Clean"), "command": .string("cleanup"),
                "icon": .string("play"), "runOnWorktreeCreate": .bool(false),
                "runOnSettle": .bool(true), "async": .bool(true),
            ])]),
        ]).decode(ServerSettingsSnapshot.self)
        let decoded = try JSONValue.encode(settings).decode(ServerSettingsSnapshot.self)
        XCTAssertEqual(decoded.github, settings.github)
        XCTAssertEqual(decoded.github?.hosts["github.com"]?.enabled, true)
        XCTAssertEqual(decoded.github?.tokens["github.example.com"], "<redacted>")
        XCTAssertEqual(decoded.defaultProjectScripts.first?.runOnSettle, true)
        XCTAssertEqual(decoded.defaultProjectScripts.first?.async, true)
        XCTAssertNil(ServerSettingsChange.defaultAutoPull(true).jsonValue["github"])
        XCTAssertEqual(try JSONValue.object([:]).decode(ServerGitHubSettings.self), ServerGitHubSettings())
    }

    func testConfigHintsPreserveMissingAndEmptyAndSkipUnknownEndpoints() throws {
        let legacy = try JSONValue.object(["providers": .array([])]).decode(ServerConfigSnapshot.self)
        XCTAssertNil(legacy.directEndpoints)
        XCTAssertNil(legacy.auth)
        let empty = try JSONValue.object([
            "providers": .array([]), "directEndpoints": .array([]),
        ]).decode(ServerConfigSnapshot.self)
        XCTAssertEqual(empty.directEndpoints, [])
        let current = try JSONValue.object([
            "providers": .array([]),
            "auth": .object(["serverUpdateScope": .string("environment:maintain")]),
            "directEndpoints": .array([
                .object(["kind": .string("future"), "httpBaseUrl": .string("https://unknown.example")]),
                .object(["kind": .string("tailnet"), "httpBaseUrl": .string("https://server.example")]),
            ]),
        ]).decode(ServerConfigSnapshot.self)
        XCTAssertEqual(current.directEndpoints?.count, 1)
        XCTAssertEqual(current.directEndpoints?.first?.kind, .tailnet)
        XCTAssertEqual(current.auth?.serverUpdateScope, "environment:maintain")
        XCTAssertEqual(try JSONValue.encode(current).decode(ServerConfigSnapshot.self), current)
    }

    func testWorkspaceCommandPendingAndRepositoryOriginDecode() throws {
        let oldWorkspace: JSONValue = .object([
            "cwd": .string("/repo"), "checkedAt": .string("2026-10-07T00:00:00Z"),
            "slashCommands": .array([]), "skills": .array([]),
        ])
        var workspace = try oldWorkspace.decode(ServerProviderWorkspaceSnapshot.self)
        XCTAssertNil(workspace.slashCommandsPending)
        workspace.slashCommandsPending = true
        XCTAssertEqual(try JSONValue.encode(workspace).decode(ServerProviderWorkspaceSnapshot.self).slashCommandsPending, true)
        let repository = try JSONValue.object([
            "canonicalKey": .string("github:upstream/repo"),
            "locator": .object(["source": .string("remote"), "remoteName": .string("origin"), "remoteUrl": .string("git@github.com:fork/repo.git")]),
            "origin": .object(["canonicalKey": .string("github:fork/repo"), "displayName": .string("fork/repo")]),
        ]).decode(RepositoryIdentity.self)
        XCTAssertEqual(repository.origin?.canonicalKey, "github:fork/repo")
        XCTAssertEqual(repository.canonicalKey, "github:upstream/repo")
        XCTAssertEqual(try JSONValue.encode(repository).decode(RepositoryIdentity.self), repository)
    }

    func testMonogramsDecodeCurrentAndLegacyShapesWithoutTreatingUnknownKindsAsText() throws {
        let fixtures: [[String: JSONValue]] = [
            ["kind": .string("monogram"), "text": .string("T3"), "color": .string("blue")],
            ["kind": .string("lucide"), "name": .string("code"), "monogramText": .string("T3")],
            ["kind": .string("lucide"), "name": .string("code"), "monogram": .string("T3")],
        ]
        for fields in fixtures {
            let icon = try JSONValue.object(fields).decode(ProjectIconOverride.self)
            XCTAssertEqual(icon.monogramDisplayText, "T3")
            XCTAssertEqual(try JSONValue.encode(icon).decode(ProjectIconOverride.self).monogramDisplayText, "T3")
        }
        let unknown = try JSONValue.object(["kind": .string("future"), "text": .string("T3")])
            .decode(ProjectIconOverride.self)
        XCTAssertNil(unknown.monogramDisplayText)
    }
}
