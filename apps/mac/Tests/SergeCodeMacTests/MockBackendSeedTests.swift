import Testing

@testable import SergeCodeMac

@Suite("MockBackend seed variants")
struct MockBackendSeedTests {
    @Test("seed variants use disjoint project and thread ids")
    func seedVariantsAreDisjoint() async throws {
        let local = MockBackend()
        let remote = MockBackend(seedVariant: "studio")

        let localProjects = try await local.projects()
        let remoteProjects = try await remote.projects()
        let localThreads = try await local.threads()
        let remoteThreads = try await remote.threads()

        #expect(Set(localProjects.map(\.id)).isDisjoint(with: Set(remoteProjects.map(\.id))))
        #expect(Set(localThreads.map(\.id)).isDisjoint(with: Set(remoteThreads.map(\.id))))
        #expect(remoteProjects.contains { $0.name == "infra-tools" })
        #expect(remoteThreads.contains { $0.title.contains("Provision runners") })

        let primaryThread = try #require(remoteThreads.first { $0.id == "studio-thread-1" })
        let timeline = try await remote.timeline(threadID: primaryThread.id)
        #expect(!timeline.isEmpty)
    }
}
