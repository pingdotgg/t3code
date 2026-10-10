import Foundation
import Testing
@testable import T3Code

@MainActor
@Suite("On-demand file browsing")
struct FeatureFileBrowserTests {
    private let root = FeatureFileBrowserState.Directory(
        threadID: "environment-one:thread", workspaceRoot: "/workspace", path: nil
    )
    private let readme = FeatureFileEntry(path: "README.md", name: "README.md", kind: .file)

    @Test
    func loadsOnlyOpenedFoldersAndReusesEmptyListings() async {
        let browser = FeatureFileBrowserState()
        var calls = 0
        let fetch: () async -> [FeatureFileEntry] = {
            calls += 1
            return []
        }

        await browser.load(root, fetch: fetch)
        await browser.load(root, fetch: fetch)
        #expect(calls == 1)
        #expect(browser.listing(for: root).entries == [])

        await browser.load(root, refresh: true, fetch: fetch)
        #expect(calls == 2)
    }

    @Test
    func failedRefreshKeepsEntriesUntilRetrySucceeds() async {
        let browser = FeatureFileBrowserState()
        await browser.load(root) { [readme] }
        await browser.load(root, refresh: true) { throw URLError(.notConnectedToInternet) }

        #expect(browser.listing(for: root).entries == [readme])
        #expect(browser.listing(for: root).errorMessage != nil)
        #expect(!browser.listing(for: root).isLoading)
        #expect(browser.listing(for: root).entries?.featureFiltered(by: "missing", includesHidden: true) == [])

        await browser.load(root, refresh: true) { [] }
        #expect(browser.listing(for: root).entries == [])
        #expect(browser.listing(for: root).errorMessage == nil)
    }

    @Test
    func initialFailureAndCancellationCanRetry() async {
        let browser = FeatureFileBrowserState()
        await browser.load(root) { throw URLError(.notConnectedToInternet) }
        #expect(browser.listing(for: root).entries == nil)
        #expect(browser.listing(for: root).errorMessage != nil)

        await browser.load(root) { [readme] }
        #expect(browser.listing(for: root).entries == [readme])
        #expect(browser.listing(for: root).errorMessage == nil)

        let fresh = FeatureFileBrowserState()
        await fresh.load(root) { throw CancellationError() }
        #expect(fresh.listing(for: root).errorMessage == nil)
        #expect(!fresh.listing(for: root).isLoading)
        await fresh.load(root) { [readme] }
        #expect(fresh.listing(for: root).entries == [readme])
    }

    @Test
    func oldRefreshCannotReplaceNewEntriesOrErrors() async {
        let browser = FeatureFileBrowserState()
        let suspended = SuspendedDirectoryLoad()
        let older = Task {
            await browser.load(root) { try await suspended.fetch() }
        }
        await suspended.waitUntilRequested()
        await browser.load(root, refresh: true) { [readme] }
        suspended.finish(.failure(URLError(.notConnectedToInternet)))
        await older.value

        #expect(browser.listing(for: root).entries == [readme])
        #expect(browser.listing(for: root).errorMessage == nil)
        #expect(!browser.listing(for: root).isLoading)

        let suspendedSuccess = SuspendedDirectoryLoad()
        let oldSuccess = Task {
            await browser.load(root, refresh: true) { try await suspendedSuccess.fetch() }
        }
        await suspendedSuccess.waitUntilRequested()
        await browser.load(root, refresh: true) { throw URLError(.notConnectedToInternet) }
        suspendedSuccess.finish(.success([]))
        await oldSuccess.value
        #expect(browser.listing(for: root).entries == [readme])
        #expect(browser.listing(for: root).errorMessage != nil)
    }

    @Test
    func cachesAreSeparateForEachEnvironmentAndWorktree() async {
        let browser = FeatureFileBrowserState()
        let remote = FeatureFileBrowserState.Directory(
            threadID: "environment-two:thread", workspaceRoot: root.workspaceRoot, path: nil
        )
        let worktree = FeatureFileBrowserState.Directory(
            threadID: root.threadID, workspaceRoot: "/worktree", path: nil
        )
        await browser.load(root) { [readme] }
        #expect(browser.listing(for: remote).entries == nil)
        #expect(browser.listing(for: worktree).entries == nil)
        await browser.load(remote) { [] }
        await browser.load(worktree) { [] }
        #expect(browser.listing(for: root).entries == [readme])
    }

    @Test
    func removingAFolderDiscardsItsCachedAndPendingChildren() async {
        let browser = FeatureFileBrowserState()
        let folder = FeatureFileBrowserState.Directory(
            threadID: root.threadID, workspaceRoot: root.workspaceRoot, path: "src"
        )
        let nested = FeatureFileBrowserState.Directory(
            threadID: root.threadID, workspaceRoot: root.workspaceRoot, path: "src/nested"
        )
        await browser.load(root) { [.init(path: "src", name: "src", kind: .directory)] }
        await browser.load(folder) { [.init(path: "src/nested", name: "nested", kind: .directory)] }
        let suspended = SuspendedDirectoryLoad()
        let pending = Task {
            await browser.load(nested) { try await suspended.fetch() }
        }
        await suspended.waitUntilRequested()
        await browser.load(root, refresh: true) { [] }
        suspended.finish(.success([readme]))
        await pending.value

        #expect(browser.listing(for: folder).entries == nil)
        #expect(browser.listing(for: nested).entries == nil)
    }

    @Test
    func directEntriesKeepIgnoredMetadataAndOldServersKeepNestedFolders() throws {
        let entries = [
            ProjectEntry(path: "node_modules/package/index.js", kind: .file),
            ProjectEntry(path: "node_modules", kind: .directory, ignored: true),
            ProjectEntry(path: "src/main.swift", kind: .file),
            ProjectEntry(path: ".env", kind: .file, ignored: true),
            ProjectEntry(path: "README.md", kind: .file),
        ]
        let files = NativeWorkspaceMapper.files(entries, directory: nil, workspaceRoot: "/workspace")
        #expect(files.map(\.path) == ["node_modules", "src", ".env", "README.md"])
        #expect(files.first?.isIgnored == true)
        #expect(files.first(where: { $0.name == ".env" })?.isHidden == true)
        #expect(files.featureFiltered(by: "", includesHidden: false).map(\.path) == [
            "node_modules", "src", "README.md",
        ])
        let nested = NativeWorkspaceMapper.files(entries, directory: "node_modules", workspaceRoot: "/workspace")
        #expect(nested.map(\.path) == ["node_modules/package"])
        let oldEntry = try JSONDecoder.t3.decode(FeatureFileEntry.self, from: Data(
            #"{"path":"old.txt","name":"old.txt","kind":"file","isHidden":false}"#.utf8
        ))
        #expect(!oldEntry.isIgnored)
    }

    @Test
    func directoryPathsFollowTheRemoteHostNotThePhone() {
        for workspace in [#"C:\work\app"#, #"\\server\share\app"#] {
            let entries = NativeWorkspaceMapper.files([
                .init(path: #"src\nested\file.swift"#, kind: .file),
                .init(path: #"src\file.swift"#, kind: .file),
            ], directory: #"src\nested"#, workspaceRoot: workspace)
            #expect(entries.map(\.path) == ["src/nested/file.swift"])
            #expect(entries.map(\.name) == ["file.swift"])
        }
        let posix = NativeWorkspaceMapper.files([
            .init(path: #"back\slash.txt"#, kind: .file),
        ], directory: nil, workspaceRoot: "/workspace")
        #expect(posix.map(\.path) == [#"back\slash.txt"#])
        #expect(posix.first?.kind == .file)
        #expect(NativeWorkspaceMapper.directoryPath(nil, workspaceRoot: "/workspace") == "")
    }
}

@MainActor
private final class SuspendedDirectoryLoad {
    private var continuation: CheckedContinuation<[FeatureFileEntry], Error>?
    private var requested: CheckedContinuation<Void, Never>?

    func fetch() async throws -> [FeatureFileEntry] {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            requested?.resume()
            requested = nil
        }
    }

    func waitUntilRequested() async {
        if continuation != nil { return }
        await withCheckedContinuation { requested = $0 }
    }

    func finish(_ result: Result<[FeatureFileEntry], Error>) {
        continuation?.resume(with: result)
        continuation = nil
    }
}
