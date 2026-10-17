import Foundation
import Testing
@testable import T3Code

struct ProjectCloneModelsTests {
    @Test func cloneListDecodesProgressAndTerminalStates() throws {
        let list = try JSONDecoder().decode([ProjectCloneSnapshot].self, from: Data(#"""
        [{"projectId":"project","remoteUrl":"git@example.test:team/repo.git",
          "destinationPath":"C:\\work\\repo","repository":null,"phase":"running",
          "stage":"receiving","percent":45,"detail":"12 MiB | 5 MiB/s","error":null,
          "startedAt":"2026-10-04T12:00:00Z","endedAt":null,"sequence":12},
         {"projectId":"failed","remoteUrl":"https://forge.example/team/repo.git",
          "destinationPath":"/work/repo","repository":{"provider":"forgejo","nameWithOwner":"team/repo",
          "url":"https://forge.example/team/repo","sshUrl":"git@forge.example:team/repo.git"},
          "phase":"failed","stage":"connecting","percent":null,"detail":null,"error":"Authentication failed",
          "startedAt":"2026-10-04T12:00:00Z","endedAt":"2026-10-04T12:00:01Z","sequence":13}]
        """#.utf8))
        #expect(list[0].displayName == "repo")
        #expect(list[0].progressSummary == "Receiving objects · 45% · 12 MiB | 5 MiB/s")
        #expect(list[1].phase == .failed)
        #expect(list[1].displayName == "team/repo")
        #expect(list[1].repository?.provider == .forgejo)
        #expect(list[1].error == "Authentication failed")
    }

    @Test func trackingRequiresAnExplicitCapability() throws {
        let absent = try JSONValue.object([:]).decode(EnvironmentDescriptor.Capabilities.self)
        let disabled = try JSONValue.object(["projectCloneTracking": .bool(false)]).decode(EnvironmentDescriptor.Capabilities.self)
        let enabled = try JSONValue.object(["projectCloneTracking": .bool(true)]).decode(EnvironmentDescriptor.Capabilities.self)
        #expect(absent.projectCloneTracking == nil)
        #expect(disabled.projectCloneTracking == false)
        #expect(enabled.projectCloneTracking == true)
    }
}
