import Foundation
import Testing
@testable import T3Code

@Suite("Pull request diff")
struct PullRequestDiffTests {
    @Test
    func parsesFilesAndReviewPositions() throws {
        let patch = """
        diff --git a/Sources/App.swift b/Sources/App.swift
        --- a/Sources/App.swift
        +++ b/Sources/App.swift
        @@ -10,2 +10,3 @@
         let old = true
        -let value = 1
        +let value = 2
        +let extra = true
        """

        let files = PullRequestDiffParser.parse(patch)
        let file = try #require(files.first)

        #expect(file.path == "Sources/App.swift")
        #expect(file.lines.count == 5)
        #expect(file.lines[1].oldLine == 10)
        #expect(file.lines[2].position == .deleted(11))
        #expect(file.lines[3].position == .added(11))
        #expect(file.lines[4].position == .added(12))
    }

    @Test
    func keepsRenamedFileContext() throws {
        let patch = """
        diff --git a/Old.swift b/New.swift
        --- a/Old.swift
        +++ b/New.swift
        @@ -1 +1 @@
        -old
        +new
        """

        let file = try #require(PullRequestDiffParser.parse(patch).first)

        #expect(file.oldPath == "Old.swift")
        #expect(file.path == "New.swift")
    }

    @Test
    func missingNewlineMarkersDoNotChangeReviewLineNumbers() throws {
        let patch = """
        diff --git a/App.swift b/App.swift
        --- a/App.swift
        +++ b/App.swift
        @@ -1,2 +1,2 @@
        -old
        \\ No newline at end of file
        +new
        \\ No newline at end of file
         context
        """

        let file = try #require(PullRequestDiffParser.parse(patch).first)

        #expect(file.lines.count == 4)
        #expect(file.lines[1].position == .deleted(1))
        #expect(file.lines[2].position == .added(1))
        #expect(file.lines[3].oldLine == 2)
        #expect(file.lines[3].newLine == 2)
    }

    @Test
    func repeatedDiffCursorsStopPaginationAndMarkDiffIncomplete() {
        var pagination = PullRequestDiffPagination()

        #expect(pagination.append(
            PullRequestDiffResult(
                patch: "first",
                truncated: false,
                nextCursor: "first-cursor",
                omittedFileStats: nil
            )
        ) == "first-cursor")
        #expect(pagination.append(
            PullRequestDiffResult(
                patch: "second",
                truncated: false,
                nextCursor: "second-cursor",
                omittedFileStats: nil
            )
        ) == "second-cursor")
        #expect(pagination.append(
            PullRequestDiffResult(
                patch: "third",
                truncated: false,
                nextCursor: "first-cursor",
                omittedFileStats: nil
            )
        ) == nil)

        #expect(pagination.patch == "firstsecondthird")
        #expect(pagination.isIncomplete)
    }
}

@MainActor
@Suite("Pull request pagination")
struct PullRequestPaginationTests {
    @Test
    func initialLoadStopsAfterTheFirstPage() async {
        let client = PullRequestPaginationClientStub()
        client.firstPages = [page(
            environmentID: "studio",
            numbers: [3],
            nextCursor: "studio-page-two"
        )]
        let model = PullRequestsModel(client: client)

        await model.load()

        #expect(model.rows.map(\.entry.number) == [3])
        #expect(model.hasMorePages)
        #expect(client.initialRequests.count == 1)
        #expect(client.targetedRequests.isEmpty)
    }

    @Test
    func additionalPagesKeepCursorsSeparateAndRemoveDuplicateRows() async {
        let client = PullRequestPaginationClientStub()
        client.firstPages = [
            page(environmentID: "first", numbers: [3], nextCursor: "first-page-two"),
            page(environmentID: "second", numbers: [4], nextCursor: "second-page-two"),
        ]
        client.targetedPages = [
            "first": page(environmentID: "first", numbers: [3, 2]),
            "second": page(environmentID: "second", numbers: [4, 1]),
        ]
        let model = PullRequestsModel(client: client)
        model.state = .closed
        model.involvement = .authored
        model.draftFilter = "only"
        model.query = "Fix"

        await model.load()
        await model.loadMore()

        #expect(model.rows.map(\.entry.number) == [4, 3, 2, 1])
        #expect(!model.hasMorePages)
        #expect(client.targetedRequests.map(\.environmentID) == ["first", "second"])
        #expect(client.targetedRequests[0].input.cursors == [
            "github.com pingdotgg/t3code": "first-page-two",
        ])
        #expect(client.targetedRequests[1].input.cursors == [
            "github.com pingdotgg/t3code": "second-page-two",
        ])
        #expect(client.targetedRequests.allSatisfy {
            $0.input.state == .closed
                && $0.input.involvement == .authored
                && $0.input.filters?.draft == "only"
                && $0.input.query == "Fix"
        })
    }

    @Test
    func failedComputerKeepsItsRowsWhileOtherComputersContinue() async {
        let client = PullRequestPaginationClientStub()
        client.firstPages = [
            page(environmentID: "offline", numbers: [3], nextCursor: "offline-page-two"),
            page(environmentID: "online", numbers: [2], nextCursor: "online-page-two"),
        ]
        client.failedEnvironmentIDs = ["offline"]
        client.targetedPages = [
            "online": page(environmentID: "online", numbers: [1]),
        ]
        let model = PullRequestsModel(client: client)

        await model.load()
        await model.loadMore()

        #expect(model.rows.map(\.entry.number) == [3, 2, 1])
        #expect(model.environments.first?.errorMessage == "This computer is offline.")
        #expect(model.environments.last?.errorMessage == nil)
        #expect(model.hasMorePages)
        #expect(client.targetedRequests.map(\.environmentID) == ["offline", "online"])
    }

    @Test
    func stalePaginationCannotReplaceANewerReload() async {
        let client = PullRequestPaginationClientStub()
        client.firstPages = [page(
            environmentID: "studio",
            numbers: [3],
            nextCursor: "studio-page-two"
        )]
        let model = PullRequestsModel(client: client)
        await model.load()

        let started = AsyncStream<Void>.makeStream()
        var response: CheckedContinuation<[FeaturePullRequestEnvironmentList], any Error>?
        client.beforeTargetedResponse = { _, _ in
            try await withCheckedThrowingContinuation { continuation in
                response = continuation
                started.continuation.yield()
            }
        }

        let pagination = Task { await model.loadMore() }
        var requests = started.stream.makeAsyncIterator()
        await requests.next()
        await model.loadMore()
        #expect(client.targetedRequests.count == 1)

        client.firstPages = [page(environmentID: "studio", numbers: [5])]
        await model.load()
        response?.resume(returning: [page(environmentID: "studio", numbers: [2])])
        await pagination.value

        #expect(model.rows.map(\.entry.number) == [5])
        #expect(!model.isLoadingMore)
        #expect(!model.hasMorePages)
    }

    private func page(
        environmentID: String,
        numbers: [Int],
        nextCursor: String? = nil
    ) -> FeaturePullRequestEnvironmentList {
        FeaturePullRequestEnvironmentList(
            environmentID: environmentID,
            environmentName: environmentID.capitalized,
            result: PullRequestListResult(
                viewers: [:],
                providers: [],
                entries: numbers.map(entry(number:)),
                errors: [],
                truncated: nextCursor != nil,
                nextCursors: nextCursor.map {
                    ["github.com pingdotgg/t3code": $0]
                } ?? [:]
            ),
            errorMessage: nil
        )
    }

    private func entry(number: Int) -> PullRequestListEntry {
        PullRequestListEntry(
            provider: .github,
            host: "github.com",
            projectId: "project",
            projectTitle: "T3 Code",
            repository: "pingdotgg/t3code",
            number: number,
            title: "Fix issue \(number)",
            url: "https://github.com/pingdotgg/t3code/pull/\(number)",
            author: nil,
            headBranch: "fix-\(number)",
            baseBranch: "main",
            state: .open,
            isDraft: false,
            mergeability: .mergeable,
            additions: 1,
            deletions: 0,
            createdAt: "2026-08-20T00:00:00Z",
            updatedAt: "2026-08-2\(number)T00:00:00Z",
            viewerReviewRequested: false,
            labels: [],
            reviewDecision: nil,
            checksState: nil
        )
    }
}

@MainActor
private final class PullRequestPaginationClientStub: FeatureClient {
    struct TargetedRequest {
        let environmentID: String
        let input: PullRequestListInput
    }

    enum Failure: LocalizedError {
        case offline

        var errorDescription: String? { "This computer is offline." }
    }

    var firstPages: [FeaturePullRequestEnvironmentList] = []
    var targetedPages: [String: FeaturePullRequestEnvironmentList] = [:]
    var failedEnvironmentIDs: Set<String> = []
    var initialRequests: [PullRequestListInput] = []
    var targetedRequests: [TargetedRequest] = []
    var beforeTargetedResponse:
        ((String, PullRequestListInput) async throws -> [FeaturePullRequestEnvironmentList])?

    func pullRequestLists(_ input: PullRequestListInput) async throws
        -> [FeaturePullRequestEnvironmentList]
    {
        initialRequests.append(input)
        return firstPages
    }

    func pullRequestLists(
        _ input: PullRequestListInput,
        environmentID: String
    ) async throws -> [FeaturePullRequestEnvironmentList] {
        targetedRequests.append(TargetedRequest(environmentID: environmentID, input: input))
        if let beforeTargetedResponse {
            return try await beforeTargetedResponse(environmentID, input)
        }
        if failedEnvironmentIDs.contains(environmentID) {
            throw Failure.offline
        }
        return targetedPages[environmentID].map { [$0] } ?? []
    }

    func initialSnapshot() async throws -> FeatureSnapshot { FeatureSnapshot() }
    func pair(endpoint: String, token: String?) async throws {}

    func createThread(
        projectID: String,
        title: String?,
        selection: FeatureSelection?
    ) async throws -> FeatureThread {
        FeatureThread(id: "created", projectID: projectID, title: title ?? "Created")
    }

    func renameThread(id: String, title: String) async throws {}
    func setThreadArchived(id: String, archived: Bool) async throws {}
    func deleteThread(id: String) async throws {}

    func loadThread(id: String) async throws -> FeatureThreadDetail {
        FeatureThreadDetail(thread: FeatureThread(id: id, projectID: "project", title: "Task"))
    }

    func sendMessage(threadID: String, text: String, selection: FeatureSelection?) async throws {}
    func cancelTurn(threadID: String) async throws {}
    func resolveApproval(id: String, decision: FeatureApprovalDecision) async throws {}
    func saveSettings(_ settings: FeatureSettings) async throws {}
}
