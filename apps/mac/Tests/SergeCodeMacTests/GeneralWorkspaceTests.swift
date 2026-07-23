import Foundation
import Testing

@testable import SergeCodeMac

@Suite("General workspace path helpers")
struct GeneralWorkspaceTests {
    @Test("resolved path expands home and standardizes")
    func resolvedPathExpandsHome() {
        let resolved = GeneralWorkspace.resolvedPath
        #expect(resolved.hasPrefix("/"))
        #expect(resolved.hasSuffix("/Documents/SergeCode/General"))
        #expect(!resolved.contains("~"))
    }

    @Test("pathsMatch ignores trailing slashes and tilde form")
    func pathsMatchNormalizes() {
        let absolute = GeneralWorkspace.resolvedPath
        #expect(GeneralWorkspace.pathsMatch(absolute, absolute + "/"))
        #expect(GeneralWorkspace.pathsMatch(GeneralWorkspace.relativePath, absolute))
        #expect(GeneralWorkspace.isGeneralProjectPath(absolute + "/"))
        #expect(!GeneralWorkspace.pathsMatch(absolute, absolute + "/other"))
    }

    @Test("normalize strips trailing slashes but keeps root")
    func normalizeStripsTrailingSlashes() {
        #expect(GeneralWorkspace.normalize("/tmp/foo/") == GeneralWorkspace.normalize("/tmp/foo"))
        #expect(GeneralWorkspace.normalize("/") == "/")
    }
}

@Suite("AppModel Quick Chat")
@MainActor
struct AppModelQuickChatTests {
    @Test("ensureGeneralProject reuses an existing project at the General path")
    func ensureReusesExisting() async {
        let backend = MockBackend()
        let model = AppModel(backend: backend)
        let path = GeneralWorkspace.resolvedPath
        let existing = Project(id: "general-existing", name: "General", path: path + "/")
        model.enqueue(.projectsChanged([existing]))
        model.flushPendingEvents()

        let ensured = await model.ensureGeneralProject()
        #expect(ensured?.id == "general-existing")
        #expect(model.projects.filter { GeneralWorkspace.isGeneralProjectPath($0.path) }.count == 1)
    }

    @Test("ensureGeneralProject creates once when missing")
    func ensureCreatesWhenMissing() async {
        let backend = MockBackend()
        let model = AppModel(backend: backend)

        let first = await model.ensureGeneralProject()
        #expect(first != nil)
        #expect(first.map { GeneralWorkspace.isGeneralProjectPath($0.path) } == true)
        #expect(first?.name == "General" || first.map { ($0.path as NSString).lastPathComponent } == "General")

        let second = await model.ensureGeneralProject()
        #expect(second?.id == first?.id)
        #expect(model.projects.filter { GeneralWorkspace.isGeneralProjectPath($0.path) }.count == 1)
    }

    @Test("preferredQuickChatProvider prefers last-used runnable provider")
    func preferredProviderFromRecentThread() async {
        let backend = MockBackend()
        let model = AppModel(backend: backend)
        await seedRunnableProviders(model)

        let older = ChatThread(
            id: "t-old", projectID: "p1", title: "Old", provider: .claude,
            status: .idle, updatedAt: Date(timeIntervalSince1970: 10))
        let newer = ChatThread(
            id: "t-new", projectID: "p1", title: "New", provider: .codex,
            status: .idle, updatedAt: Date(timeIntervalSince1970: 20))
        model.enqueue(.threadUpserted(older))
        model.enqueue(.threadUpserted(newer))
        model.flushPendingEvents()

        #expect(model.preferredQuickChatProvider == .codex)
    }

    @Test("preferredQuickChatProvider falls back when last-used is not runnable")
    func preferredProviderFallback() async {
        let backend = MockBackend()
        let model = AppModel(backend: backend)
        await seedRunnableProviders(model)

        // Grok is in seed models as available; force last-used to legacyCursor which is not runnable.
        let stale = ChatThread(
            id: "t-legacy", projectID: "p1", title: "Legacy", provider: .legacyCursor,
            status: .idle, updatedAt: Date())
        model.enqueue(.threadUpserted(stale))
        model.flushPendingEvents()

        let preferred = model.preferredQuickChatProvider
        #expect(preferred != nil)
        #expect(preferred != .legacyCursor)
        #expect(model.runnableProviderKinds.contains(preferred!))
    }

    @Test("startQuickChat fails clearly without a ready provider")
    func startQuickChatWithoutProviders() async {
        let backend = MockBackend()
        let model = AppModel(backend: backend)
        // No providers/models injected → not runnable.
        let scenery = SceneryStore()
        let thread = await model.startQuickChat(scenery: scenery)
        #expect(thread == nil)
        #expect(model.lastError?.contains("providers") == true)
    }

    private func seedRunnableProviders(_ model: AppModel) async {
        model.enqueue(
            .providersChanged([
                ProviderInstance(
                    id: "provider-claude", kind: .claude, availability: .available, version: "1"),
                ProviderInstance(
                    id: "provider-codex", kind: .codex, availability: .available, version: "1"),
            ]))
        model.flushPendingEvents()
        await model.refreshModels()
    }
}
