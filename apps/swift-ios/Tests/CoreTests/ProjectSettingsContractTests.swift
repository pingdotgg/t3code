import XCTest
@testable import T3Code

final class ProjectSettingsContractTests: XCTestCase {
    func testMissingNullAndExplicitValuesHaveDifferentMeanings() throws {
        let model = ModelSelection(instanceId: "codex", model: "default-model")
        var settings = ServerSettingsSnapshot()
        settings.defaultModelSelection = model
        settings.projectSettingsOverrides = [
            "empty": [:],
            "none": ["defaultModelSelection": .null, "sidebarAutoSettleAfterDays": .null],
            "explicit": ["newWorktreesStartFromOrigin": .bool(false)],
        ]
        XCTAssertEqual(settings.resolvingProject(id: "empty").defaultModelSelection, model)
        XCTAssertNil(settings.resolvingProject(id: "none").defaultModelSelection)
        XCTAssertNil(settings.resolvingProject(id: "none").sidebarAutoSettleAfterDays)
        XCTAssertFalse(settings.resolvingProject(id: "explicit").newWorktreesStartFromOrigin)
        let decoded = try JSONValue.encode(settings).decode(ServerSettingsSnapshot.self)
        XCTAssertEqual(decoded.projectSettingsOverrides, settings.projectSettingsOverrides)
    }

    func testProjectPatchReplacesOneEntryAndKeepsUnrelatedKeys() throws {
        let settings = try JSONValue.object([
            "projectSettingsOverrides": .object([
                "one": .object([
                    "enableAgentBrowserAccess": .bool(false),
                    "defaultModelSelection": .null,
                    "responseStreamingMode": .string("turn"),
                    "futureSetting": .object(["value": .string("keep")]),
                ]),
                "two": .object(["defaultAutoPull": .bool(true)]),
            ]),
        ]).decode(ServerSettingsSnapshot.self)
        let patch = ServerProjectSettingChange(key: .responseStreamingMode, value: nil)
            .patch(projectID: "one", settings: settings).jsonValue
        XCTAssertEqual(patch, .object([
            "projectSettingsOverrides": .object([
                "one": .object([
                    "enableAgentBrowserAccess": .bool(false),
                    "defaultModelSelection": .null,
                    "futureSetting": .object(["value": .string("keep")]),
                ]),
            ]),
        ]))
        XCTAssertEqual(
            ServerProjectSettingChange(key: .defaultAutoPull, value: nil)
                .patch(projectID: "two", settings: settings).jsonValue,
            .object(["projectSettingsOverrides": .object(["two": .null])])
        )
        XCTAssertEqual(
            ServerProjectSettingChange(key: .defaultModelSelection, value: .null)
                .patch(projectID: "empty", settings: settings).jsonValue,
            .object(["projectSettingsOverrides": .object([
                "empty": .object(["defaultModelSelection": .null]),
            ])])
        )
    }

    func testFoldedSettingsDoNotRestoreLegacyProjectDefaults() {
        let legacy = ModelSelection(instanceId: "codex", model: "old-default")
        var settings = ServerSettingsSnapshot()
        let beforeFold = settings.resolvingProject(
            id: "project", legacyModelSelection: legacy, legacyWorkspaceMode: .worktree
        )
        XCTAssertEqual(beforeFold.defaultModelSelection, legacy)
        XCTAssertEqual(beforeFold.defaultThreadEnvMode, .worktree)
        settings.projectSettingsFolded = true
        let afterReset = settings.resolvingProject(
            id: "project", legacyModelSelection: legacy, legacyWorkspaceMode: .worktree
        )
        XCTAssertNil(afterReset.defaultModelSelection)
        XCTAssertEqual(afterReset.defaultThreadEnvMode, .local)
    }

    func testExplicitOverridesWinBeforeFoldAndDisabledModelsInherit() throws {
        var settings = ServerSettingsSnapshot()
        settings.defaultModelSelection = ModelSelection(instanceId: "active", model: "environment")
        settings.projectSettingsOverrides = ["project": [
            "defaultModelSelection": .null,
            "defaultThreadEnvMode": .string("local"),
        ]]
        let legacy = ModelSelection(instanceId: "codex", model: "legacy")
        let explicit = settings.resolvingProject(
            id: "project", legacyModelSelection: legacy, legacyWorkspaceMode: .worktree
        )
        XCTAssertNil(explicit.defaultModelSelection)
        XCTAssertEqual(explicit.defaultThreadEnvMode, .local)
        settings.projectSettingsOverrides["project"]?["defaultModelSelection"] = try JSONValue.encode(legacy)
        XCTAssertEqual(
            settings.resolvingProject(id: "project", disabledProviderIDs: ["codex"]).defaultModelSelection,
            settings.defaultModelSelection
        )
    }

    func testStreamingModesAndOlderServerSupport() throws {
        let oldSettings = try JSONValue.object([
            "enableLegacyTokenStreaming": .bool(true),
            "enableAssistantStreaming": .bool(true),
        ]).decode(ServerSettingsSnapshot.self)
        XCTAssertNil(oldSettings.responseStreamingMode)
        XCTAssertTrue(oldSettings.projectSettingsOverrides.isEmpty)
        XCTAssertFalse(oldSettings.projectSettingsFolded)
        XCTAssertNil(try JSONValue.object([:]).decode(EnvironmentDescriptor.Capabilities.self).projectSettingsOverrides)

        for mode in ResponseStreamingMode.allCases {
            let settings = try JSONValue.object([
                "responseStreamingMode": .string("paragraph"),
                "projectSettingsOverrides": .object([
                    "project": .object(["responseStreamingMode": .string(mode.rawValue)]),
                ]),
            ]).decode(ServerSettingsSnapshot.self)
            XCTAssertEqual(settings.responseStreamingMode, .paragraph)
            XCTAssertEqual(settings.resolvingProject(id: "project").responseStreamingMode, mode)
            XCTAssertEqual(ServerSettingsChange.responseStreamingMode(mode).jsonValue,
                           .object(["responseStreamingMode": .string(mode.rawValue)]))
            XCTAssertNil(settings.sharedPatch["projectSettingsOverrides"])
            XCTAssertNil(settings.sharedPatch["responseStreamingMode"])
        }
    }
}
