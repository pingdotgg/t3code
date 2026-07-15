import Foundation
import Testing

@testable import SergeCodeMac

@Suite("Sidebar presentation")
@MainActor
struct SidebarPresentationTests {
    @Test("repository identity merges local and remote projects")
    func repositoryIdentityMergesProjects() {
        let local = makeModel(
            projects: [
                Project(
                    id: "local-project", name: "SergeCode", path: "/local/SergeCode",
                    repositoryKey: "github.com/sergeserb2/sergecode")
            ],
            threads: [makeThread(id: "local-thread", projectID: "local-project")])
        let remote = makeRemote(
            id: "studio",
            name: "Studio Mac",
            projects: [
                Project(
                    id: "remote-project", name: "SergeCode", path: "/remote/SergeCode",
                    repositoryKey: "github.com/sergeserb2/sergecode")
            ],
            threads: [makeThread(id: "remote-thread", projectID: "remote-project")])
        let multi = MultiDeviceModel(local: local, remoteSessions: [remote])

        let groups = SidebarProjection.projectGroups(in: multi, scope: .all)

        #expect(groups.count == 1)
        #expect(groups[0].members.count == 2)
        #expect(groups[0].threads.map(\.id).map(\.deviceID) == [.local, remote.id])
    }

    @Test("search matches every project name in a repository group")
    func searchMatchesEveryGroupedProjectName() {
        let repositoryKey = "github.com/sergeserb2/sergecode"
        let local = makeModel(
            projects: [
                Project(
                    id: "local-project", name: "SergeCode", path: "/local/SergeCode",
                    repositoryKey: repositoryKey)
            ],
            threads: [makeThread(id: "local-thread", projectID: "local-project")])
        let remote = makeRemote(
            id: "studio",
            name: "Studio Mac",
            projects: [
                Project(
                    id: "remote-project", name: "Sidebar Prototype",
                    path: "/remote/SergeCode", repositoryKey: repositoryKey)
            ],
            threads: [])
        let groups = SidebarProjection.projectGroups(
            in: MultiDeviceModel(local: local, remoteSessions: [remote]), scope: .all)

        #expect(
            SidebarProjection.searchResults(in: groups, query: "Sidebar Prototype")
                .map(\.thread.id) == ["local-thread"])
    }

    @Test("project name is a safe fallback across machines")
    func projectNameFallbackMergesProjects() {
        let local = makeModel(
            projects: [Project(id: "local-project", name: "Dashboard", path: "/local/dashboard")],
            threads: [makeThread(id: "local-thread", projectID: "local-project")])
        let remote = makeRemote(
            id: "mini",
            name: "Mac mini",
            projects: [Project(id: "remote-project", name: "dashboard", path: "/remote/dashboard")],
            threads: [makeThread(id: "remote-thread", projectID: "remote-project")])
        let multi = MultiDeviceModel(local: local, remoteSessions: [remote])

        let groups = SidebarProjection.projectGroups(in: multi, scope: .all)

        #expect(groups.count == 1)
        #expect(groups[0].members.count == 2)
    }

    @Test("duplicate names on one machine remain distinct")
    func duplicateNamesStayDistinct() {
        let local = makeModel(
            projects: [
                Project(id: "first", name: "App", path: "/work/first"),
                Project(id: "second", name: "App", path: "/work/second"),
            ],
            threads: [
                makeThread(id: "first-thread", projectID: "first"),
                makeThread(id: "second-thread", projectID: "second"),
            ])
        let multi = MultiDeviceModel(local: local)

        let groups = SidebarProjection.projectGroups(in: multi, scope: .all)

        #expect(groups.count == 2)
    }

    @Test("attention running and pinned shortcuts are disjoint")
    func smartSectionsAreDisjoint() {
        let suffix = UUID().uuidString
        let projectID = "project-\(suffix)"
        let approval = makeThread(
            id: "approval-\(suffix)", projectID: projectID, status: .waitingApproval, at: 4)
        let running = makeThread(
            id: "running-\(suffix)", projectID: projectID, status: .running, at: 3)
        let pinned = makeThread(
            id: "pinned-\(suffix)", projectID: projectID, status: .idle, at: 2)
        let local = makeModel(
            projects: [Project(id: projectID, name: "Project", path: "/project")],
            threads: [approval, running, pinned])
        local.togglePinned(pinned)
        defer { local.togglePinned(pinned) }
        let multi = MultiDeviceModel(local: local)
        let groups = SidebarProjection.projectGroups(in: multi, scope: .all)

        let attention = SidebarProjection.attentionThreads(in: groups)
        let active = SidebarProjection.runningThreads(in: groups)
        let pins = SidebarProjection.pinnedThreads(in: groups)

        #expect(attention.map(\.thread.id) == [approval.id])
        #expect(active.map(\.thread.id) == [running.id])
        #expect(pins.map(\.thread.id) == [pinned.id])
        #expect(Set(attention.map(\.id)).isDisjoint(with: Set(active.map(\.id))))
        #expect(Set(attention.map(\.id)).isDisjoint(with: Set(pins.map(\.id))))
        #expect(Set(active.map(\.id)).isDisjoint(with: Set(pins.map(\.id))))
    }

    @Test("machine scope and search use the unified projection")
    func scopeAndSearch() {
        let local = makeModel(
            projects: [Project(id: "local-project", name: "Website", path: "/website")],
            threads: [
                makeThread(
                    id: "local-thread", projectID: "local-project", title: "Polish landing page")
            ])
        let remote = makeRemote(
            id: "build-mac",
            name: "Build Mac",
            projects: [Project(id: "remote-project", name: "API", path: "/api")],
            threads: [
                makeThread(
                    id: "remote-thread", projectID: "remote-project", title: "Repair deploy")
            ])
        let multi = MultiDeviceModel(local: local, remoteSessions: [remote])

        let remoteGroups = SidebarProjection.projectGroups(
            in: multi, scope: .device(remote.id))
        let allGroups = SidebarProjection.projectGroups(in: multi, scope: .all)

        #expect(remoteGroups.count == 1)
        #expect(remoteGroups[0].threads.allSatisfy { $0.member.location.id == remote.id })
        #expect(
            SidebarProjection.searchResults(in: allGroups, query: "Build Mac")
                .map(\.thread.id) == ["remote-thread"])
        #expect(
            SidebarProjection.searchResults(in: allGroups, query: "landing")
                .map(\.thread.id) == ["local-thread"])
    }

    private func makeModel(
        projects: [Project],
        threads: [ChatThread],
        deviceID: DeviceID = .local,
        deviceName: String? = nil,
        capabilities: BackendCapabilities = .local
    ) -> AppModel {
        let model = AppModel(
            backend: MockBackend(),
            deviceID: deviceID,
            deviceName: deviceName,
            capabilities: capabilities)
        model.enqueue(.projectsChanged(projects))
        threads.forEach { model.enqueue(.threadUpserted($0)) }
        model.flushPendingEvents()
        return model
    }

    private func makeRemote(
        id: String,
        name: String,
        projects: [Project],
        threads: [ChatThread]
    ) -> RemoteDeviceSession {
        let deviceID = DeviceID(rawValue: id)
        let model = makeModel(
            projects: projects,
            threads: threads,
            deviceID: deviceID,
            deviceName: name,
            capabilities: .remote)
        return RemoteDeviceSession(
            descriptor: RemoteDeviceDescriptor(id: deviceID, name: name, host: "\(id).local"),
            model: model)
    }

    private func makeThread(
        id: String,
        projectID: String,
        title: String? = nil,
        status: ThreadStatus = .idle,
        at timestamp: TimeInterval = 1
    ) -> ChatThread {
        ChatThread(
            id: id,
            projectID: projectID,
            title: title ?? id,
            provider: .codex,
            status: status,
            updatedAt: Date(timeIntervalSince1970: timestamp))
    }
}
