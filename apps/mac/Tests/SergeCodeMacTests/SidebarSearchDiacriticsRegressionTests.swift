import Foundation
import Testing

@testable import SergeCodeMac

/// Threads are auto-titled after scenery locations, several of which carry
/// diacritics, so sidebar search has to fold them for ASCII queries.
@Suite("Sidebar search diacritics")
@MainActor
struct SidebarSearchDiacriticsRegressionTests {
    @Test("accented thread titles match unaccented queries")
    func accentedTitlesMatchAsciiQueries() {
        let groups = makeGroups(
            titles: ["Skógafoss, Iceland", "Cappadocia, Türkiye", "Unrelated session"])

        #expect(
            SidebarProjection.searchResults(in: groups, query: "skogafoss").map(\.thread.id)
                == ["thread-0"])
        #expect(
            SidebarProjection.searchResults(in: groups, query: "turkiye").map(\.thread.id)
                == ["thread-1"])
    }

    @Test("accented queries still match accented titles")
    func accentedQueriesStillMatch() {
        let groups = makeGroups(titles: ["Skógafoss, Iceland"])

        #expect(
            SidebarProjection.searchResults(in: groups, query: "Skógafoss").map(\.thread.id)
                == ["thread-0"])
    }

    @Test("accented project names match unaccented queries")
    func accentedProjectNamesMatchAsciiQueries() {
        let model = makeModel(
            projects: [Project(id: "project", name: "Café Tooling", path: "/work/cafe")],
            threads: [makeThread(id: "thread-0", projectID: "project", title: "Session")])
        let groups = SidebarProjection.projectGroups(
            in: MultiDeviceModel(local: model, remoteSessions: []), scope: .all)

        #expect(
            SidebarProjection.searchResults(in: groups, query: "cafe").map(\.thread.id)
                == ["thread-0"])
    }

    @Test("non-matching queries stay empty")
    func unrelatedQueriesFindNothing() {
        let groups = makeGroups(titles: ["Skógafoss, Iceland"])

        #expect(SidebarProjection.searchResults(in: groups, query: "reykjavik").isEmpty)
    }

    private func makeGroups(titles: [String]) -> [SidebarProjectGroup] {
        let model = makeModel(
            projects: [Project(id: "project", name: "Tooling", path: "/work/tooling")],
            threads: titles.enumerated().map { index, title in
                makeThread(id: "thread-\(index)", projectID: "project", title: title)
            })
        return SidebarProjection.projectGroups(
            in: MultiDeviceModel(local: model, remoteSessions: []), scope: .all)
    }

    private func makeModel(projects: [Project], threads: [ChatThread]) -> AppModel {
        let model = AppModel(
            backend: MockBackend(),
            deviceID: .local,
            deviceName: nil,
            capabilities: .local)
        model.enqueue(.projectsChanged(projects))
        threads.forEach { model.enqueue(.threadUpserted($0)) }
        model.flushPendingEvents()
        return model
    }

    private func makeThread(id: String, projectID: String, title: String) -> ChatThread {
        ChatThread(
            id: id,
            projectID: projectID,
            title: title,
            provider: .codex,
            status: .idle,
            updatedAt: Date(timeIntervalSince1970: 1))
    }
}
