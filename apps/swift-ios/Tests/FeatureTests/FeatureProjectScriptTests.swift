import Foundation
import Testing
@testable import T3Code

@MainActor
struct FeatureProjectScriptTests {
    private func script(_ id: String) -> ProjectScript {
        .init(id: id, name: id, command: "vp run \(id)", icon: "play", runOnWorktreeCreate: false,
              previewUrl: nil, autoOpenPreview: nil)
    }

    @Test func projectOverrideWinsIncludingAnEmptyOverride() throws {
        var settings = ServerSettingsSnapshot()
        settings.defaultProjectScripts = [script("default")]
        settings.projectSettingsFolded = true
        settings.projectSettingsOverrides["project"] = ["defaultProjectScripts": try JSONValue.encode([script("override")])]
        #expect(FeatureProjectScriptSettings.resolve(settings: settings, projectID: "project", scripts: [script("legacy")]) == [script("override")])
        settings.projectSettingsOverrides["project"] = ["defaultProjectScripts": .array([])]
        #expect(FeatureProjectScriptSettings.resolve(settings: settings, projectID: "project", scripts: [script("legacy")]).isEmpty)
        #expect(FeatureProjectScriptSettings.resolve(settings: settings, projectID: "other", scripts: [script("legacy")]) == [script("default")])
    }

    @Test func olderSettingsPreserveLegacyResetOverrideAndProjectScripts() throws {
        var settings = ServerSettingsSnapshot()
        settings.defaultProjectScripts = [script("default")]
        let resolve = { (settings: ServerSettingsSnapshot, scripts: [ProjectScript]) in
            FeatureProjectScriptSettings.resolve(settings: settings, projectID: "project", scripts: scripts)
        }
        #expect(resolve(settings, [script("aggregate")]) == [script("aggregate")])
        #expect(resolve(settings, []) == [script("default")])
        settings.projectScriptOverrides["project"] = try JSONValue.encode([script("legacy")])
        #expect(resolve(settings, [script("aggregate")]) == [script("legacy")])
        settings.projectScriptOverrides["project"] = .null
        #expect(resolve(settings, [script("aggregate")]) == [script("default")])
        settings.projectScriptOverrides["project"] = .array([])
        #expect(resolve(settings, [script("aggregate")]).isEmpty)
        settings.projectSettingsFolded = true
        #expect(resolve(settings, [script("aggregate")]) == [script("default")])
    }

    @Test func identicalProjectIDsResolveAgainstTheirOwnEnvironmentSettings() {
        var first = ServerSettingsSnapshot()
        first.projectSettingsFolded = true
        first.defaultProjectScripts = [script("local")]
        var remote = ServerSettingsSnapshot()
        remote.projectSettingsFolded = true
        remote.defaultProjectScripts = [script("remote")]
        #expect(FeatureProjectScriptSettings.resolve(settings: first, projectID: "same-wire-id", scripts: []) == [script("local")])
        #expect(FeatureProjectScriptSettings.resolve(settings: remote, projectID: "same-wire-id", scripts: []) == [script("remote")])
    }

    @Test func launchUsesWorktreeAndProjectVariablesWithoutRewritingTheCommand() {
        let command = #"vp run dev -- --name 'my task'"#
        let remote = FeatureProjectScriptLaunch(
            projectRoot: #"C:\projects\app"#, worktreePath: #"D:\worktrees\task"#, command: command
        )
        #expect(remote.cwd == #"D:\worktrees\task"#)
        #expect(remote.worktreePath == remote.cwd)
        #expect(remote.environmentVariables == [
            "T3CODE_PROJECT_ROOT": #"C:\projects\app"#,
            "T3CODE_WORKTREE_PATH": #"D:\worktrees\task"#,
        ])
        #expect(remote.input == command + "\r")
        let local = FeatureProjectScriptLaunch(projectRoot: "/repo", worktreePath: nil, command: "vp test")
        #expect(local.cwd == "/repo")
        #expect(local.worktreePath == nil)
        #expect(local.environmentVariables == ["T3CODE_PROJECT_ROOT": "/repo"])
    }

    @Test func scriptSessionSelectionNeverUsesAnotherEnvironmentOrRunningShell() {
        let scopedID = "one:thread"
        let remote = FeatureTerminalSnapshot(threadID: "two:thread", terminalID: "default", state: .running)
        #expect(FeatureProjectScriptLaunch.terminalID(threadID: scopedID, sessions: [remote]) == "default")
        let running = FeatureTerminalSnapshot(threadID: scopedID, terminalID: "default", state: .running)
        let second = FeatureTerminalSnapshot(threadID: scopedID, terminalID: "term-2", state: .starting)
        #expect(FeatureProjectScriptLaunch.terminalID(threadID: scopedID, sessions: [remote, running, second]) == "term-3")
        let exited = FeatureTerminalSnapshot(threadID: scopedID, terminalID: "default", state: .exited)
        #expect(FeatureProjectScriptLaunch.terminalID(threadID: scopedID, sessions: [remote, exited]) == "default")
        let unknown = FeatureProjectScriptLaunch.terminalID(threadID: scopedID, sessions: nil)
        #expect(unknown.hasPrefix("script-"))
        #expect(unknown != FeatureProjectScriptLaunch.terminalID(threadID: scopedID, sessions: nil))
    }

    @Test func commandIsSentOnlyAfterOpenAndOnlyOnce() async throws {
        let launch = FeatureProjectScriptLaunch(projectRoot: "/repo", worktreePath: nil, command: "vp run test")
        var operations: [String] = []
        try await launch.execute(validate: {}, open: {
            operations.append("open")
        }, write: { operations.append($0) })
        #expect(operations == ["open", "vp run test\r"])
    }

    @Test func failedOpenAndChangedWorkspaceDoNotSendCommands() async {
        let launch = FeatureProjectScriptLaunch(projectRoot: "/repo", worktreePath: nil, command: "vp run test")
        var writes: [String] = []
        do {
            try await launch.execute(validate: {}, open: {
                throw URLError(.notConnectedToInternet)
            }, write: { writes.append($0) })
            Issue.record("Expected opening to fail")
        } catch {}
        #expect(writes.isEmpty)

        var contextMatches = true
        do {
            try await launch.execute(validate: {
                guard contextMatches else { throw CancellationError() }
            }, open: {
                contextMatches = false
            }, write: { writes.append($0) })
            Issue.record("Expected the changed context to cancel the launch")
        } catch { #expect(error is CancellationError) }
        #expect(writes.isEmpty)
    }

    @Test func aFailedWriteDoesNotRetryOrSendTheRemainingCommand() async {
        let command = String(repeating: "x", count: TerminalInputEncoder.maximumWriteLength + 10)
        let launch = FeatureProjectScriptLaunch(projectRoot: "/repo", worktreePath: nil, command: command)
        var writes: [String] = []
        do {
            try await launch.execute(validate: {}, open: {}, write: { chunk in
                writes.append(chunk)
                throw URLError(.networkConnectionLost)
            })
            Issue.record("Expected the write to fail")
        } catch {}
        #expect(writes.count == 1)
        #expect(writes.first?.hasSuffix("\r") == false)
    }
}

extension FeatureProjectScriptTests {
    @Test func settleScriptRolesSurviveProjectResolution() throws {
        let base: [String: JSONValue] = [
            "id": .string("cleanup"), "name": .string("Clean"), "command": .string("cleanup"),
            "icon": .string("play"), "runOnWorktreeCreate": .bool(false),
        ]
        let legacy = try JSONValue.object(base).decode(ProjectScript.self)
        #expect(legacy.runOnSettle == nil)
        #expect(legacy.menuLabel == "Clean")
        for setup in [false, true] {
            var fields = base
            fields["runOnWorktreeCreate"] = .bool(setup)
            fields["runOnSettle"] = .bool(true)
            fields["async"] = .bool(true)
            var settings = ServerSettingsSnapshot()
            settings.projectSettingsOverrides["project"] = ["defaultProjectScripts": .array([.object(fields)])]
            let script = try #require(FeatureProjectScriptSettings.resolve(settings: settings, projectID: "project", scripts: []).first)
            #expect(script.runOnSettle == true)
            #expect(script.async == true)
            #expect(script.menuLabel == (setup ? "Clean (setup, on settle)" : "Clean (on settle)"))
        }
    }
}
