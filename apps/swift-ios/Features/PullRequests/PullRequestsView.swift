import Observation
import SwiftUI

struct FeaturePullRequestRow: Identifiable, Equatable {
    let environmentID: String
    let environmentName: String
    let entry: PullRequestListEntry

    var id: String { "\(environmentID):\(entry.id)" }
    var target: FeaturePullRequestTarget {
        FeaturePullRequestTarget(
            environmentID: environmentID,
            environmentName: environmentName,
            reference: PullRequestRef(
                projectId: entry.projectId,
                repository: entry.repository,
                number: entry.number
            )
        )
    }
}

@MainActor
@Observable
final class PullRequestsModel {
    var rows: [FeaturePullRequestRow] = []
    private var allRows: [FeaturePullRequestRow] = []
    var environments: [FeaturePullRequestEnvironmentList] = []
    var state: PullRequestListState = .open
    var involvement: PullRequestInvolvement = .all
    var query = ""
    var draftFilter: String?
    var reviewFilter: String?
    var checksFilter: String?
    var environmentFilter: String?
    var hostFilter: String?
    var projectFilter: String?
    var isLoading = false
    var isLoadingMore = false
    var errorMessage: String?

    private let client: any FeatureClient
    private var loadGeneration: UInt64 = 0
    private var loadedInput: PullRequestListInput?

    init(client: any FeatureClient) {
        self.client = client
    }

    func load(invalidate: Bool = false) async {
        loadGeneration &+= 1
        let generation = loadGeneration
        isLoading = true
        isLoadingMore = false
        errorMessage = nil
        defer {
            if loadGeneration == generation {
                isLoading = false
            }
        }
        do {
            if invalidate { try await client.invalidatePullRequests(nil) }
            let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
            let filters = PullRequestListFilters(
                draft: draftFilter,
                review: reviewFilter,
                checks: checksFilter
            )
            let input = PullRequestListInput(
                state: state,
                involvement: involvement,
                filters: filters == PullRequestListFilters() ? nil : filters,
                query: trimmedQuery.isEmpty ? nil : trimmedQuery
            )
            let result = try await client.pullRequestLists(input)
            guard !Task.isCancelled, loadGeneration == generation else { return }
            loadedInput = input
            environments = result
            updateRows()
        } catch {
            guard loadGeneration == generation, !(error is CancellationError) else { return }
            errorMessage = error.localizedDescription
        }
    }

    var hasMorePages: Bool {
        environments.contains { environment in
            (environmentFilter == nil || environment.environmentID == environmentFilter)
                && environment.result?.nextCursors.isEmpty == false
        }
    }

    func loadMore() async {
        guard !isLoading, !isLoadingMore, let loadedInput else { return }

        let pending = environments.compactMap { environment -> (String, [String: String])? in
            guard environmentFilter == nil || environment.environmentID == environmentFilter,
                  let cursors = environment.result?.nextCursors,
                  !cursors.isEmpty else {
                return nil
            }
            return (environment.environmentID, cursors)
        }
        guard !pending.isEmpty else { return }

        let generation = loadGeneration
        isLoadingMore = true
        defer {
            if loadGeneration == generation {
                isLoadingMore = false
            }
        }

        for (environmentID, cursors) in pending {
            guard !Task.isCancelled, loadGeneration == generation else { return }

            let input = PullRequestListInput(
                state: loadedInput.state,
                involvement: loadedInput.involvement,
                filters: loadedInput.filters,
                projectId: loadedInput.projectId,
                projectIds: loadedInput.projectIds,
                host: loadedInput.host,
                limit: loadedInput.limit,
                cursors: cursors,
                query: loadedInput.query
            )

            do {
                let pages = try await client.pullRequestLists(
                    input,
                    environmentID: environmentID
                )
                guard !Task.isCancelled, loadGeneration == generation else { return }
                guard let page = pages.first(where: { $0.environmentID == environmentID }),
                      let index = environments.firstIndex(where: {
                          $0.environmentID == environmentID
                      }) else {
                    continue
                }

                let previous = environments[index]
                let result: PullRequestListResult? = if let pageResult = page.result {
                    previous.result?.appending(pageResult) ?? pageResult
                } else {
                    previous.result
                }
                environments[index] = FeaturePullRequestEnvironmentList(
                    environmentID: environmentID,
                    environmentName: page.environmentName,
                    result: result,
                    errorMessage: page.errorMessage
                )
                updateRows()
            } catch {
                guard loadGeneration == generation,
                      !(error is CancellationError),
                      let index = environments.firstIndex(where: {
                          $0.environmentID == environmentID
                      }) else {
                    return
                }
                let previous = environments[index]
                environments[index] = FeaturePullRequestEnvironmentList(
                    environmentID: environmentID,
                    environmentName: previous.environmentName,
                    result: previous.result,
                    errorMessage: error.localizedDescription
                )
            }
        }
    }

    func applyLocalFilters() {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        rows = allRows.filter { row in
            (environmentFilter == nil || row.environmentID == environmentFilter)
                && (hostFilter == nil || row.entry.host == hostFilter)
                && (projectFilter == nil
                    || "\(row.environmentID):\(row.entry.projectId)" == projectFilter)
                && (needle.isEmpty
                    || row.entry.title.lowercased().contains(needle)
                    || row.entry.repository.lowercased().contains(needle)
                    || row.entry.author?.login.lowercased().contains(needle) == true
                    || String(row.entry.number) == needle)
        }
    }

    var environmentOptions: [(String, String)] {
        Dictionary(uniqueKeysWithValues: environments.map { ($0.environmentID, $0.environmentName) })
            .sorted { $0.value < $1.value }
    }

    var hostOptions: [String] { Array(Set(allRows.map(\.entry.host))).sorted() }

    var projectOptions: [(String, String)] {
        let values = allRows.reduce(into: [String: String]()) { result, row in
            result["\(row.environmentID):\(row.entry.projectId)"] = row.entry.projectTitle
        }
        return values.sorted { $0.value < $1.value }
    }

    private func updateRows() {
        var seenRowIDs = Set<String>()
        allRows = environments.flatMap { environment in
            (environment.result?.entries ?? []).map {
                FeaturePullRequestRow(
                    environmentID: environment.environmentID,
                    environmentName: environment.environmentName,
                    entry: $0
                )
            }
        }
        .filter { seenRowIDs.insert($0.id).inserted }
        .sorted { $0.entry.updatedAt > $1.entry.updatedAt }
        applyLocalFilters()
    }
}

public struct PullRequestsView: View {
    @Bindable private var rootModel: FeatureRootModel
    @State private var model: PullRequestsModel
    @State private var searchTask: Task<Void, Never>?

    public init(model: FeatureRootModel) {
        rootModel = model
        _model = State(initialValue: PullRequestsModel(client: model.client))
    }

    public var body: some View {
        VStack(spacing: 0) {
            filters
            Divider().overlay(T3Colors.separator)
            content
        }
        .background(T3Colors.background)
        .navigationTitle("Pull Requests")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { Task { await model.load(invalidate: true) } } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .disabled(model.isLoading)
            }
        }
        .t3NavigationChrome()
        .task { await model.load() }
        .onChange(of: model.state) { reload() }
        .onChange(of: model.involvement) { reload() }
        .onChange(of: model.draftFilter) { reload() }
        .onChange(of: model.reviewFilter) { reload() }
        .onChange(of: model.checksFilter) { reload() }
        .onChange(of: model.environmentFilter) { model.applyLocalFilters() }
        .onChange(of: model.hostFilter) { model.applyLocalFilters() }
        .onChange(of: model.projectFilter) { model.applyLocalFilters() }
        .onChange(of: model.query) {
            searchTask?.cancel()
            searchTask = Task {
                try? await Task.sleep(for: .milliseconds(300))
                guard !Task.isCancelled else { return }
                await model.load()
            }
        }
    }

    private var filters: some View {
        VStack(spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(T3Colors.textTertiary)
                TextField("Search pull requests", text: $model.query)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                filterMenu
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 44)
            .background(T3Colors.input, in: RoundedRectangle(cornerRadius: 12))

            HStack(spacing: 12) {
                Picker("State", selection: $model.state) {
                    ForEach(PullRequestListState.allCases, id: \.self) {
                        Text($0.label).tag($0)
                    }
                }
                .pickerStyle(.segmented)

                Menu {
                    Picker("Involvement", selection: $model.involvement) {
                        ForEach(PullRequestInvolvement.allCases, id: \.self) {
                            Text($0.label).tag($0)
                        }
                    }
                } label: {
                    Label(model.involvement.label, systemImage: "person.2")
                        .font(T3Typography.control)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private var filterMenu: some View {
        Menu {
            Menu("Drafts") {
                filterButton("Any", value: nil, selection: $model.draftFilter)
                filterButton("Only drafts", value: "only", selection: $model.draftFilter)
                filterButton("Hide drafts", value: "hide", selection: $model.draftFilter)
            }
            Menu("Review") {
                filterButton("Any", value: nil, selection: $model.reviewFilter)
                filterButton("Approved", value: "approved", selection: $model.reviewFilter)
                filterButton(
                    "Changes requested",
                    value: "changes-requested",
                    selection: $model.reviewFilter
                )
                filterButton(
                    "Review required",
                    value: "review-required",
                    selection: $model.reviewFilter
                )
                filterButton("No review", value: "none", selection: $model.reviewFilter)
            }
            Menu("Checks") {
                filterButton("Any", value: nil, selection: $model.checksFilter)
                filterButton("Passing", value: "passing", selection: $model.checksFilter)
                filterButton("Failing", value: "failing", selection: $model.checksFilter)
            }
            Menu("Computer") {
                filterButton("All computers", value: nil, selection: $model.environmentFilter)
                ForEach(model.environmentOptions, id: \.0) { id, name in
                    filterButton(name, value: id, selection: $model.environmentFilter)
                }
            }
            Menu("Host") {
                filterButton("All hosts", value: nil, selection: $model.hostFilter)
                ForEach(model.hostOptions, id: \.self) { host in
                    filterButton(host, value: host, selection: $model.hostFilter)
                }
            }
            Menu("Project") {
                filterButton("All projects", value: nil, selection: $model.projectFilter)
                ForEach(model.projectOptions, id: \.0) { id, name in
                    filterButton(name, value: id, selection: $model.projectFilter)
                }
            }
            if hasExtraFilters {
                Divider()
                Button("Clear filters") {
                    model.draftFilter = nil
                    model.reviewFilter = nil
                    model.checksFilter = nil
                    model.environmentFilter = nil
                    model.hostFilter = nil
                    model.projectFilter = nil
                }
            }
        } label: {
            Image(systemName: hasExtraFilters ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
                .font(.system(size: 18))
                .foregroundStyle(hasExtraFilters ? T3Colors.accent : T3Colors.textSecondary)
        }
    }

    private func filterButton(
        _ title: String,
        value: String?,
        selection: Binding<String?>
    ) -> some View {
        Button {
            selection.wrappedValue = value
        } label: {
            if selection.wrappedValue == value {
                Label(title, systemImage: "checkmark")
            } else {
                Text(title)
            }
        }
    }

    private var hasExtraFilters: Bool {
        model.draftFilter != nil || model.reviewFilter != nil || model.checksFilter != nil
            || model.environmentFilter != nil || model.hostFilter != nil
            || model.projectFilter != nil
    }

    @ViewBuilder
    private var content: some View {
        if model.isLoading, model.rows.isEmpty {
            ProgressView("Loading pull requests…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let error = model.errorMessage, model.rows.isEmpty {
            ContentUnavailableView("Couldn’t load pull requests", systemImage: "exclamationmark.triangle", description: Text(error))
        } else {
            List {
                ForEach(model.environments.filter { $0.errorMessage != nil }) { environment in
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(environment.environmentName)
                                .font(T3Typography.supportingStrong)
                            Text("Unavailable. Other computers are still shown.")
                                .font(T3Typography.supporting)
                                .foregroundStyle(T3Colors.textSecondary)
                        }
                    } icon: {
                        Image(systemName: "exclamationmark.circle")
                            .foregroundStyle(T3Colors.warning)
                    }
                }

                ForEach(model.rows) { row in
                    NavigationLink {
                        PullRequestDetailView(rootModel: rootModel, row: row)
                    } label: {
                        PullRequestRowView(row: row)
                    }
                }

                if model.rows.isEmpty {
                    ContentUnavailableView(
                        "No pull requests",
                        systemImage: "arrow.triangle.pull",
                        description: Text("Try another state, involvement, or search.")
                    )
                    .listRowBackground(Color.clear)
                }

                if model.hasMorePages {
                    Button {
                        Task { await model.loadMore() }
                    } label: {
                        HStack {
                            Spacer()
                            if model.isLoadingMore {
                                ProgressView()
                            }
                            Text(model.isLoadingMore ? "Loading more..." : "Load more")
                            Spacer()
                        }
                    }
                    .disabled(model.isLoading || model.isLoadingMore)
                    .listRowBackground(Color.clear)
                }
            }
            .listStyle(.plain)
            .refreshable { await model.load(invalidate: true) }
        }
    }

    private func reload() {
        Task { await model.load() }
    }
}

private struct PullRequestRowView: View {
    let row: FeaturePullRequestRow

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 7) {
                Image(systemName: row.entry.state.systemImage)
                    .foregroundStyle(row.entry.state.color)
                Text("\(row.entry.repository) #\(row.entry.number)")
                    .font(T3Typography.supportingStrong)
                    .foregroundStyle(T3Colors.textSecondary)
                Spacer(minLength: 8)
                Text(row.environmentName)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textTertiary)
            }
            Text(row.entry.title)
                .font(T3Typography.threadBody.weight(.semibold))
                .foregroundStyle(T3Colors.textPrimary)
                .lineLimit(2)
            HStack(spacing: 10) {
                if let author = row.entry.author { Text(author.login) }
                Text("\(row.entry.headBranch) → \(row.entry.baseBranch)")
                    .lineLimit(1)
                Spacer(minLength: 4)
                if row.entry.additions > 0 || row.entry.deletions > 0 {
                    Text("+\(row.entry.additions)").foregroundStyle(T3Colors.success)
                    Text("−\(row.entry.deletions)").foregroundStyle(T3Colors.danger)
                }
            }
            .font(T3Typography.supporting)
            .foregroundStyle(T3Colors.textSecondary)
        }
        .padding(.vertical, 5)
    }
}

@MainActor
@Observable
private final class PullRequestDetailModel {
    var detail: PullRequestDetail?
    var activity: PullRequestActivity?
    var diffFiles: [PullRequestDiffFile] = []
    var isDiffIncomplete = false
    var isLoading = true
    var isLoadingDiff = false
    var isActing = false
    var errorMessage: String?
    var reviewDrafts: [PullRequestReviewCommentDraft] = []
    var reviewerCandidates: [PullRequestReviewerCandidate] = []
    var isLoadingReviewers = false

    private let client: any FeatureClient
    let target: FeaturePullRequestTarget

    init(client: any FeatureClient, target: FeaturePullRequestTarget) {
        self.client = client
        self.target = target
    }

    func load(invalidate: Bool = false) async {
        isLoading = true
        errorMessage = nil
        do {
            if invalidate { try await client.invalidatePullRequests(target) }
            detail = try await client.pullRequestDetail(target)
            activity = try? await client.pullRequestActivity(target)
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    func loadDiff() async {
        guard detail?.capabilities.diff == true, diffFiles.isEmpty, !isLoadingDiff else { return }
        isLoadingDiff = true
        do {
            var cursor: String?
            var pagination = PullRequestDiffPagination()
            repeat {
                let page = try await client.pullRequestDiff(target, cursor: cursor)
                cursor = pagination.append(page)
            } while cursor != nil
            diffFiles = PullRequestDiffParser.parse(pagination.patch)
            isDiffIncomplete = pagination.isIncomplete
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoadingDiff = false
    }

    func run(
        _ action: PullRequestAction,
        mergeMethod: PullRequestMergeMethod? = nil,
        updateMethod: PullRequestUpdateMethod? = nil
    ) async {
        await mutate {
            try await client.runPullRequestAction(
                target,
                action: action,
                mergeMethod: mergeMethod,
                updateMethod: updateMethod
            )
        }
    }

    func update(title: String? = nil, body: String? = nil) async {
        await mutate { try await client.updatePullRequest(target, title: title, body: body) }
    }

    func comment(_ body: String) async {
        await mutate { try await client.commentOnPullRequest(target, body: body) }
    }

    func review(verdict: PullRequestReviewVerdict, body: String) async -> Bool {
        var submitted = false
        await mutate {
            try await client.submitPullRequestReview(
                target,
                verdict: verdict,
                body: body,
                comments: reviewDrafts
            )
            reviewDrafts = []
            submitted = true
        }
        return submitted
    }

    func reply(threadID: String, body: String) async {
        await mutate {
            try await client.replyToPullRequestThread(target, threadID: threadID, body: body)
        }
    }

    func resolve(thread: PullRequestReviewThread) async {
        await mutate {
            try await client.setPullRequestThreadResolved(
                target,
                threadID: thread.id,
                resolved: !thread.isResolved
            )
        }
    }

    func react(subjectID: String?, reaction: PullRequestReactionContent, reacted: Bool) async {
        await mutate {
            try await client.setPullRequestReaction(
                target,
                subjectID: subjectID,
                content: reaction,
                reacted: reacted
            )
        }
    }

    func loadReviewers() async {
        guard !isLoadingReviewers else { return }
        isLoadingReviewers = true
        do {
            reviewerCandidates = try await client.pullRequestReviewerCandidates(target).candidates
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoadingReviewers = false
    }

    func toggleReviewer(_ reviewer: PullRequestReviewerCandidate) async {
        await mutate {
            try await client.requestPullRequestReviewers(
                target,
                reviewers: [reviewer],
                requested: !reviewer.isRequested
            )
        }
        await loadReviewers()
    }

    private func mutate(_ operation: () async throws -> Void) async {
        isActing = true
        do {
            try await operation()
            try await client.invalidatePullRequests(target)
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
        isActing = false
    }
}

private enum PullRequestDetailTab: String, CaseIterable {
    case summary = "Summary"
    case conversation = "Activity"
    case files = "Files"
}

struct PullRequestDetailView: View {
    private struct PendingAction: Identifiable {
        let id = UUID()
        let action: PullRequestAction
        var mergeMethod: PullRequestMergeMethod?
        var updateMethod: PullRequestUpdateMethod?
    }

    @Bindable var rootModel: FeatureRootModel
    let target: FeaturePullRequestTarget
    @State private var model: PullRequestDetailModel
    @State private var tab: PullRequestDetailTab = .summary
    @State private var editor: PullRequestEditor?
    @State private var reviewSheet = false
    @State private var reviewerSheet = false
    @State private var notice: String?
    @State private var pendingAction: PendingAction?

    init(rootModel: FeatureRootModel, row: FeaturePullRequestRow) {
        self.init(rootModel: rootModel, target: row.target)
    }

    init(rootModel: FeatureRootModel, target: FeaturePullRequestTarget) {
        self.rootModel = rootModel
        self.target = target
        _model = State(initialValue: PullRequestDetailModel(client: rootModel.client, target: target))
    }

    var body: some View {
        Group {
            if model.isLoading, model.detail == nil {
                ProgressView("Loading pull request…")
            } else if let detail = model.detail {
                VStack(spacing: 0) {
                    detailHeader(detail)
                    Picker("Section", selection: $tab) {
                        ForEach(PullRequestDetailTab.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 10)

                    Divider().overlay(T3Colors.separator)
                    tabContent(detail)
                }
            } else {
                ContentUnavailableView(
                    "Couldn’t load pull request",
                    systemImage: "exclamationmark.triangle",
                    description: Text(model.errorMessage ?? "Try again.")
                )
            }
        }
        .background(T3Colors.background)
        .navigationTitle("#\(target.reference.number)")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { actionMenu }
        }
        .t3NavigationChrome()
        .task { await model.load() }
        .onChange(of: tab) { _, value in
            if value == .files { Task { await model.loadDiff() } }
        }
        .sheet(item: $editor) { editor in
            PullRequestEditSheet(editor: editor) { value in
                Task {
                    switch editor.kind {
                    case .title: await model.update(title: value)
                    case .body: await model.update(body: value)
                    case .comment: await model.comment(value)
                    }
                }
            }
        }
        .sheet(isPresented: $reviewSheet) {
            PullRequestReviewSheet(model: model)
        }
        .sheet(isPresented: $reviewerSheet) {
            PullRequestReviewerSheet(model: model)
        }
        .alert("Pull request", isPresented: Binding(
            get: { notice != nil },
            set: { if !$0 { notice = nil } }
        )) { Button("OK") {} } message: { Text(notice ?? "") }
        .alert("Action failed", isPresented: Binding(
            get: { model.errorMessage != nil },
            set: { if !$0 { model.errorMessage = nil } }
        )) { Button("OK") {} } message: { Text(model.errorMessage ?? "") }
        .alert(
            "Confirm pull request action",
            isPresented: Binding(
                get: { pendingAction != nil },
                set: { if !$0 { pendingAction = nil } }
            ),
            presenting: pendingAction
        ) { pending in
            Button(pending.action.label, role: .destructive) {
                pendingAction = nil
                Task {
                    await model.run(
                        pending.action,
                        mergeMethod: pending.mergeMethod,
                        updateMethod: pending.updateMethod
                    )
                }
            }
            Button("Cancel", role: .cancel) { pendingAction = nil }
        } message: { pending in
            Text("This action will \(pending.action.label.lowercased()).")
        }
    }

    private func detailHeader(_ detail: PullRequestDetail) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(detail.title)
                .font(T3Typography.threadHeading3)
                .foregroundStyle(T3Colors.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 7) {
                Label(detail.state.label, systemImage: detail.state.systemImage)
                    .foregroundStyle(detail.state.color)
                Text("\(detail.repository) · \(target.environmentName)")
                Spacer()
                Text("+\(detail.additions)").foregroundStyle(T3Colors.success)
                Text("−\(detail.deletions)").foregroundStyle(T3Colors.danger)
            }
            .font(T3Typography.supporting)
            .foregroundStyle(T3Colors.textSecondary)
        }
        .padding(16)
    }

    @ViewBuilder
    private func tabContent(_ detail: PullRequestDetail) -> some View {
        switch tab {
        case .summary:
            PullRequestSummaryView(
                detail: detail,
                activity: model.activity,
                model: model,
                onUpdateBranch: { method in
                    pendingAction = PendingAction(action: .updateBranch, updateMethod: method)
                }
            )
        case .conversation:
            PullRequestActivityView(activity: model.activity, model: model)
        case .files:
            PullRequestFilesView(
                files: model.diffFiles,
                isLoading: model.isLoadingDiff,
                isIncomplete: model.isDiffIncomplete,
                drafts: $model.reviewDrafts,
                canComment: detail.capabilities.review.inlineComment
                    && detail.viewerPermissions.comment,
                sendToAgent: sendToAgent
            )
        }
    }

    @ViewBuilder
    private var actionMenu: some View {
        if let detail = model.detail {
            Menu {
                if detail.capabilities.edit?.changeRequest == true {
                    Button("Edit title", systemImage: "pencil") {
                        editor = PullRequestEditor(kind: .title, value: detail.title)
                    }
                    Button("Edit description", systemImage: "doc.text") {
                        editor = PullRequestEditor(kind: .body, value: detail.body)
                    }
                }
                if detail.capabilities.comment, detail.viewerPermissions.comment {
                    Button("Add comment", systemImage: "text.bubble") {
                        editor = PullRequestEditor(kind: .comment, value: "")
                    }
                }
                if !detail.viewerPermissions.verdicts.isEmpty {
                    Button("Review changes", systemImage: "checkmark.bubble") { reviewSheet = true }
                }
                if detail.capabilities.reviewers.request,
                   detail.capabilities.reviewers.listCandidates,
                   detail.viewerPermissions.requestReviewers {
                    Button("Manage reviewers", systemImage: "person.badge.plus") {
                        reviewerSheet = true
                    }
                }
                Divider()
                ForEach(detail.viewerPermissions.actions, id: \.self) { action in
                    if detail.capabilities.actions.contains(action),
                       action != .merge,
                       action != .updateBranch {
                        Button(action.label, systemImage: action.systemImage) {
                            if action == .close || action == .enableAutoMerge {
                                pendingAction = PendingAction(action: action)
                            } else {
                                Task { await model.run(action) }
                            }
                        }
                    }
                }
                if detail.capabilities.actions.contains(.merge),
                   detail.viewerPermissions.actions.contains(.merge) {
                    Menu("Merge pull request") {
                        ForEach(availableMergeMethods(detail), id: \.self) { method in
                            Button(method.label) {
                                pendingAction = PendingAction(action: .merge, mergeMethod: method)
                            }
                        }
                    }
                }
            } label: {
                if model.isActing { ProgressView() } else { Image(systemName: "ellipsis.circle") }
            }
            .disabled(model.isActing)
        }
    }

    private func availableMergeMethods(_ detail: PullRequestDetail) -> [PullRequestMergeMethod] {
        detail.capabilities.mergeMethods.filter {
            switch $0 {
            case .merge: detail.mergeCapabilities.merge
            case .squash: detail.mergeCapabilities.squash
            case .rebase: detail.mergeCapabilities.rebase
            }
        }
    }

    private func sendToAgent(_ line: PullRequestDiffLine, file: PullRequestDiffFile) {
        guard let project = rootModel.snapshot.projects.first(where: {
            $0.environmentID == target.environmentID
                && ($0.wireID ?? $0.id) == target.reference.projectId
        }) else {
            notice = "The project for this pull request is not available on this computer."
            return
        }
        guard let selection = DailyUXCreationContext.initialSelection(
            for: project,
            in: rootModel.snapshot
        ) else {
            notice = "Choose a default model for this project first."
            return
        }
        let prompt = """
        Please inspect and address this line from pull request #\(target.reference.number) in \(target.reference.repository).

        File: \(file.path)
        Line: \(line.displayLineNumber)

        ```diff
        \(line.text)
        ```
        """
        Task {
            let thread = await rootModel.startTask(
                NewTaskRequest(
                    projectID: project.id,
                    prompt: prompt,
                    selection: selection,
                    runtimeMode: .fullAccess,
                    interactionMode: .standard
                )
            )
            notice = thread == nil ? "The task could not be started." : "Sent to a new agent thread."
        }
    }
}

private struct PullRequestSummaryView: View {
    let detail: PullRequestDetail
    let activity: PullRequestActivity?
    @Bindable var model: PullRequestDetailModel
    let onUpdateBranch: (PullRequestUpdateMethod) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 22) {
                if detail.baseComparison == .behind,
                   detail.capabilities.actions.contains(.updateBranch),
                   detail.viewerPermissions.actions.contains(.updateBranch) {
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Branch is behind").font(T3Typography.supportingStrong)
                            Text(detail.behindBy.map { "\($0) commits behind \(detail.baseBranch)" } ?? "Update from \(detail.baseBranch)")
                                .font(T3Typography.supporting)
                                .foregroundStyle(T3Colors.textSecondary)
                        }
                        Spacer()
                        Menu("Update") {
                            ForEach(detail.viewerPermissions.updateMethods ?? [], id: \.self) { method in
                                Button(method.rawValue.capitalized) {
                                    onUpdateBranch(method)
                                }
                            }
                        }
                        .buttonStyle(.borderedProminent)
                    }
                    .padding(14)
                    .background(T3Colors.surface, in: RoundedRectangle(cornerRadius: 14))
                }

                if !detail.body.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        sectionTitle("Description")
                        MarkdownMessageView(detail.body, copyActionTitle: "Copy description")
                    }
                }

                if !detail.checks.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        sectionTitle("Checks")
                        ForEach(detail.checks) { check in
                            HStack(spacing: 9) {
                                Image(systemName: check.status.systemImage)
                                    .foregroundStyle(check.status.color)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(check.name).font(T3Typography.control)
                                    if let description = check.description {
                                        Text(description)
                                            .font(T3Typography.supporting)
                                            .foregroundStyle(T3Colors.textSecondary)
                                    }
                                }
                                Spacer()
                            }
                        }
                    }
                }

                if !detail.reviewers.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        sectionTitle("Reviewers")
                        ForEach(detail.reviewers, id: \.login) { reviewer in
                            Label(reviewer.name ?? reviewer.login, systemImage: "person.crop.circle")
                                .font(T3Typography.control)
                        }
                    }
                }

                if detail.capabilities.reactions == true {
                    PullRequestReactionsView(
                        reactions: activity?.reactions ?? [],
                        onToggle: { reaction, reacted in
                            Task { await model.react(subjectID: nil, reaction: reaction, reacted: reacted) }
                        }
                    )
                }
            }
            .padding(16)
        }
    }

    private func sectionTitle(_ value: String) -> some View {
        Text(value.uppercased())
            .font(T3Typography.eyebrow)
            .foregroundStyle(T3Colors.textSecondary)
    }
}

private struct PullRequestActivityView: View {
    let activity: PullRequestActivity?
    @Bindable var model: PullRequestDetailModel
    @State private var replyThread: PullRequestReviewThread?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                if let activity {
                    ForEach(activity.comments) { comment in
                        PullRequestCommentView(comment: comment, model: model)
                    }
                    ForEach(activity.reviewThreads) { thread in
                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                Label("\(thread.path):\(thread.line.map(String.init) ?? "file")", systemImage: "text.bubble")
                                    .font(T3Typography.supportingStrong)
                                Spacer()
                                if model.detail?.capabilities.review.resolve == true,
                                   model.detail?.viewerPermissions.resolve == true {
                                    Button(thread.isResolved ? "Reopen" : "Resolve") {
                                        Task { await model.resolve(thread: thread) }
                                    }
                                    .font(T3Typography.supportingStrong)
                                }
                            }
                            ForEach(thread.comments) { comment in
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(comment.author?.login ?? "Unknown")
                                        .font(T3Typography.supportingStrong)
                                    MarkdownMessageView(comment.body, copyActionTitle: "Copy comment")
                                    if model.detail?.capabilities.reactions == true {
                                        PullRequestReactionsView(
                                            reactions: comment.reactions ?? []
                                        ) { reaction, reacted in
                                            Task {
                                                await model.react(
                                                    subjectID: comment.id,
                                                    reaction: reaction,
                                                    reacted: reacted
                                                )
                                            }
                                        }
                                    }
                                }
                            }
                            if model.detail?.capabilities.review.reply == true,
                               model.detail?.viewerPermissions.comment == true {
                                Button("Reply") { replyThread = thread }
                                    .font(T3Typography.control)
                            }
                        }
                        .padding(14)
                        .background(T3Colors.surface, in: RoundedRectangle(cornerRadius: 14))
                    }
                    ForEach(activity.commits) { commit in
                        HStack(spacing: 10) {
                            Image(systemName: "point.topleft.down.to.point.bottomright.curvepath")
                            Text(commit.messageHeadline).lineLimit(2)
                            Spacer()
                            Text(String(commit.oid.prefix(7))).monospaced()
                        }
                        .font(T3Typography.supporting)
                    }
                    if activity.comments.isEmpty && activity.reviewThreads.isEmpty && activity.commits.isEmpty {
                        ContentUnavailableView("No activity", systemImage: "text.bubble")
                    }
                } else {
                    ProgressView("Loading activity…")
                }
            }
            .padding(16)
        }
        .sheet(item: $replyThread) { thread in
            PullRequestTextSheet(title: "Reply", initialValue: "") { body in
                Task { await model.reply(threadID: thread.id, body: body) }
            }
        }
    }
}

private struct PullRequestCommentView: View {
    let comment: PullRequestComment
    @Bindable var model: PullRequestDetailModel

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                Text(comment.author?.name ?? comment.author?.login ?? "Unknown")
                    .font(T3Typography.supportingStrong)
                if let state = comment.reviewState {
                    Text(state.replacingOccurrences(of: "_", with: " ").lowercased())
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                }
                Spacer()
            }
            if !comment.body.isEmpty {
                MarkdownMessageView(comment.body, copyActionTitle: "Copy comment")
            }
            if model.detail?.capabilities.reactions == true {
                PullRequestReactionsView(reactions: comment.reactions ?? []) { reaction, reacted in
                    Task {
                        await model.react(
                            subjectID: comment.id,
                            reaction: reaction,
                            reacted: reacted
                        )
                    }
                }
            }
        }
        .padding(14)
        .background(T3Colors.surface, in: RoundedRectangle(cornerRadius: 14))
    }
}

private struct PullRequestReactionsView: View {
    let reactions: [PullRequestReaction]
    let onToggle: (PullRequestReactionContent, Bool) -> Void

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 7) {
                ForEach(reactions) { reaction in
                    Button {
                        onToggle(reaction.content, !reaction.viewerHasReacted)
                    } label: {
                        Text("\(reaction.content.emoji) \(reaction.count)")
                    }
                    .buttonStyle(.bordered)
                    .tint(reaction.viewerHasReacted ? T3Colors.accent : T3Colors.textSecondary)
                }
                Menu {
                    ForEach(PullRequestReactionContent.allCases, id: \.self) { reaction in
                        Button("\(reaction.emoji)  \(reaction.label)") { onToggle(reaction, true) }
                    }
                } label: {
                    Image(systemName: "face.smiling")
                }
                .buttonStyle(.bordered)
            }
        }
        .scrollIndicators(.hidden)
    }
}

private struct PullRequestFilesView: View {
    let files: [PullRequestDiffFile]
    let isLoading: Bool
    let isIncomplete: Bool
    @Binding var drafts: [PullRequestReviewCommentDraft]
    let canComment: Bool
    let sendToAgent: (PullRequestDiffLine, PullRequestDiffFile) -> Void
    @State private var commentingLine: PullRequestDiffSelection?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                if isIncomplete {
                    Label(
                        "Some changes are missing from this diff.",
                        systemImage: "exclamationmark.triangle"
                    )
                    .font(T3Typography.supportingStrong)
                    .foregroundStyle(T3Colors.warning)
                }
                if isLoading {
                    ProgressView("Loading diff…")
                        .frame(maxWidth: .infinity)
                        .padding(.top, 50)
                } else if files.isEmpty {
                    ContentUnavailableView("No diff available", systemImage: "doc.text.magnifyingglass")
                } else {
                    ForEach(files) { file in
                        VStack(alignment: .leading, spacing: 0) {
                            Text(file.path)
                                .font(T3Typography.supportingStrong.monospaced())
                                .padding(12)
                            Divider().overlay(T3Colors.separator)
                            ScrollView(.horizontal) {
                                LazyVStack(alignment: .leading, spacing: 0) {
                                    ForEach(file.lines) { line in
                                        HStack(spacing: 0) {
                                            Text(line.oldLine.map(String.init) ?? "")
                                                .frame(width: 42, alignment: .trailing)
                                            Text(line.newLine.map(String.init) ?? "")
                                                .frame(width: 42, alignment: .trailing)
                                            Text(line.text)
                                                .padding(.leading, 10)
                                                .frame(minWidth: 500, alignment: .leading)
                                        }
                                        .font(T3Typography.code)
                                        .t3CodeTextSize()
                                        .foregroundStyle(line.foreground)
                                        .padding(.vertical, 2)
                                        .background(line.background)
                                        .contentShape(Rectangle())
                                        .contextMenu {
                                            if canComment, line.position != nil {
                                                Button("Add review comment", systemImage: "text.bubble") {
                                                    commentingLine = PullRequestDiffSelection(file: file, line: line)
                                                }
                                            }
                                            Button("Send line to agent", systemImage: "paperplane") {
                                                sendToAgent(line, file)
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        .background(T3Colors.surface, in: RoundedRectangle(cornerRadius: 12))
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(T3Colors.border))
                    }
                }
            }
            .padding(16)
        }
        .sheet(item: $commentingLine) { selection in
            PullRequestTextSheet(title: "Review comment", initialValue: "") { body in
                guard let position = selection.line.position else { return }
                drafts.append(
                    PullRequestReviewCommentDraft(
                        path: selection.file.path,
                        oldPath: selection.file.oldPath,
                        position: position,
                        body: body
                    )
                )
            }
        }
    }
}

private struct PullRequestReviewSheet: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @Bindable var model: PullRequestDetailModel
    @State private var verdict: PullRequestReviewVerdict = .comment
    @State private var reviewBody = ""

    var body: some View {
        NavigationStack {
            Form {
                Picker("Verdict", selection: $verdict) {
                    ForEach(model.detail?.viewerPermissions.verdicts ?? [], id: \.self) {
                        Text($0.label).tag($0)
                    }
                }
                Section("Summary") {
                    TextEditor(text: $reviewBody).frame(minHeight: 130)
                }
                if !model.reviewDrafts.isEmpty {
                    Section("Inline comments") {
                        ForEach(model.reviewDrafts) { draft in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(draft.path).font(T3Typography.supportingStrong.monospaced())
                                Text(draft.body).font(T3Typography.threadBody)
                            }
                        }
                        .onDelete { model.reviewDrafts.remove(atOffsets: $0) }
                    }
                }
            }
            .navigationTitle("Submit Review")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Submit") {
                        Task {
                            if await model.review(verdict: verdict, body: reviewBody) {
                                dismiss()
                            }
                        }
                    }
                    .disabled(model.isActing)
                }
            }
            .onAppear {
                verdict = model.detail?.viewerPermissions.verdicts.first ?? .comment
            }
        }
    }
}

private struct PullRequestReviewerSheet: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @Bindable var model: PullRequestDetailModel

    var body: some View {
        NavigationStack {
            List {
                if model.isLoadingReviewers, model.reviewerCandidates.isEmpty {
                    ProgressView("Loading reviewers…")
                }
                ForEach(model.reviewerCandidates) { reviewer in
                    Button {
                        Task { await model.toggleReviewer(reviewer) }
                    } label: {
                        HStack {
                            Image(systemName: reviewer.kind == "team" ? "person.3" : "person.crop.circle")
                            VStack(alignment: .leading, spacing: 2) {
                                Text(reviewer.name ?? reviewer.login)
                                    .foregroundStyle(T3Colors.textPrimary)
                                if reviewer.name != nil {
                                    Text(reviewer.login)
                                        .font(T3Typography.supporting)
                                        .foregroundStyle(T3Colors.textSecondary)
                                }
                            }
                            Spacer()
                            if reviewer.isRequested { Image(systemName: "checkmark") }
                        }
                    }
                }
            }
            .navigationTitle("Reviewers")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .task { await model.loadReviewers() }
        }
    }
}

private struct PullRequestEditor: Identifiable {
    enum Kind { case title, body, comment }
    let id = UUID()
    let kind: Kind
    let value: String
}

private struct PullRequestEditSheet: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    let editor: PullRequestEditor
    let save: (String) -> Void
    @State private var value: String

    init(editor: PullRequestEditor, save: @escaping (String) -> Void) {
        self.editor = editor
        self.save = save
        _value = State(initialValue: editor.value)
    }

    var body: some View {
        PullRequestTextSheet(title: editor.kind.title, initialValue: editor.value, save: save)
    }
}

private struct PullRequestTextSheet: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    let title: String
    let save: (String) -> Void
    @State private var value: String

    init(title: String, initialValue: String, save: @escaping (String) -> Void) {
        self.title = title
        self.save = save
        _value = State(initialValue: initialValue)
    }

    var body: some View {
        NavigationStack {
            TextEditor(text: $value)
                .font(T3Typography.threadBody)
                .padding(12)
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") { save(value); dismiss() }
                            .disabled(value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
        }
    }
}

struct PullRequestDiffFile: Identifiable, Equatable {
    let id: String
    let path: String
    let oldPath: String?
    let lines: [PullRequestDiffLine]
}

struct PullRequestDiffLine: Identifiable, Equatable {
    enum Kind { case context, added, deleted, header }
    let id: Int
    let kind: Kind
    let text: String
    let oldLine: Int?
    let newLine: Int?

    var displayLineNumber: Int { newLine ?? oldLine ?? 0 }
    var position: PullRequestReviewPosition? {
        switch kind {
        case .added: newLine.map(PullRequestReviewPosition.added)
        case .deleted: oldLine.map(PullRequestReviewPosition.deleted)
        case .context:
            if let oldLine, let newLine {
                PullRequestReviewPosition.context(old: oldLine, new: newLine, side: .right)
            } else { nil }
        case .header: nil
        }
    }
    var foreground: Color {
        switch kind {
        case .added: T3Colors.success
        case .deleted: T3Colors.danger
        case .header: T3Colors.accent
        case .context: T3Colors.textPrimary
        }
    }
    var background: Color {
        switch kind {
        case .added: T3Colors.success.opacity(0.08)
        case .deleted: T3Colors.danger.opacity(0.08)
        default: .clear
        }
    }
}

private struct PullRequestDiffSelection: Identifiable {
    var id: String { "\(file.id):\(line.id)" }
    let file: PullRequestDiffFile
    let line: PullRequestDiffLine
}

struct PullRequestDiffPagination {
    private(set) var patch = ""
    private(set) var isIncomplete = false
    private var seenCursors = Set<String>()

    mutating func append(_ page: PullRequestDiffResult) -> String? {
        patch += page.patch
        isIncomplete = isIncomplete || page.truncated
            || !(page.omittedFileStats ?? []).isEmpty

        guard let cursor = page.nextCursor, !cursor.isEmpty else { return nil }
        guard seenCursors.insert(cursor).inserted else {
            isIncomplete = true
            return nil
        }
        return cursor
    }
}

enum PullRequestDiffParser {
    static func parse(_ patch: String) -> [PullRequestDiffFile] {
        var files: [PullRequestDiffFile] = []
        var path = ""
        var oldPath: String?
        var lines: [PullRequestDiffLine] = []
        var oldLine = 0
        var newLine = 0
        var lineID = 0

        func finish() {
            guard !path.isEmpty else { return }
            files.append(.init(id: "\(files.count):\(path)", path: path, oldPath: oldPath, lines: lines))
            lines = []
            oldPath = nil
        }

        for raw in patch.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            if raw == "\\ No newline at end of file" {
                continue
            }
            if raw.hasPrefix("diff --git ") {
                finish()
                let parts = raw.split(separator: " ")
                path = parts.count > 3 ? String(parts[3]).replacingOccurrences(of: "b/", with: "", options: .anchored) : "Changed file"
                continue
            }
            if raw.hasPrefix("--- ") {
                let value = String(raw.dropFirst(4))
                oldPath = value == "/dev/null" ? nil : value.replacingOccurrences(of: "a/", with: "", options: .anchored)
                continue
            }
            if raw.hasPrefix("+++ ") {
                let value = String(raw.dropFirst(4))
                if value != "/dev/null" { path = value.replacingOccurrences(of: "b/", with: "", options: .anchored) }
                continue
            }
            if raw.hasPrefix("@@") {
                let parts = raw.split(separator: " ")
                oldLine = parts.count > 1 ? startLine(String(parts[1])) : 0
                newLine = parts.count > 2 ? startLine(String(parts[2])) : 0
                lines.append(.init(id: lineID, kind: .header, text: raw, oldLine: nil, newLine: nil))
            } else if raw.hasPrefix("+") {
                lines.append(.init(id: lineID, kind: .added, text: raw, oldLine: nil, newLine: newLine))
                newLine += 1
            } else if raw.hasPrefix("-") {
                lines.append(.init(id: lineID, kind: .deleted, text: raw, oldLine: oldLine, newLine: nil))
                oldLine += 1
            } else {
                lines.append(.init(id: lineID, kind: .context, text: raw, oldLine: oldLine, newLine: newLine))
                oldLine += 1
                newLine += 1
            }
            lineID += 1
        }
        finish()
        return files
    }

    private static func startLine(_ range: String) -> Int {
        Int(range.dropFirst().split(separator: ",").first ?? "0") ?? 0
    }
}

private extension PullRequestListState {
    var label: String { rawValue.capitalized }
}

private extension PullRequestInvolvement {
    var label: String { rawValue.capitalized }
}

private extension PullRequestState {
    var label: String { rawValue.capitalized }
    var systemImage: String {
        switch self {
        case .open: "arrow.triangle.pull"
        case .closed: "xmark.circle"
        case .merged: "arrow.triangle.merge"
        }
    }
    var color: Color {
        switch self {
        case .open: T3Colors.success
        case .closed: T3Colors.danger
        case .merged: T3Colors.syntaxKeyword
        }
    }
}

private extension PullRequestCheckStatus {
    var systemImage: String {
        switch self {
        case .success: "checkmark.circle.fill"
        case .failure: "xmark.circle.fill"
        case .pending: "clock"
        case .skipped, .neutral, .cancelled: "minus.circle"
        }
    }
    var color: Color {
        switch self {
        case .success: T3Colors.success
        case .failure: T3Colors.danger
        case .pending: T3Colors.warning
        case .skipped, .neutral, .cancelled: T3Colors.textTertiary
        }
    }
}

private extension PullRequestAction {
    var label: String {
        switch self {
        case .merge: "Merge pull request"
        case .ready: "Mark ready for review"
        case .draft: "Convert to draft"
        case .close: "Close pull request"
        case .reopen: "Reopen pull request"
        case .updateBranch: "Update branch"
        case .enableAutoMerge: "Enable auto-merge"
        case .disableAutoMerge: "Disable auto-merge"
        }
    }
    var systemImage: String {
        switch self {
        case .merge: "arrow.triangle.merge"
        case .ready: "checkmark.circle"
        case .draft: "pencil.circle"
        case .close: "xmark.circle"
        case .reopen: "arrow.uturn.backward.circle"
        case .updateBranch: "arrow.clockwise"
        case .enableAutoMerge: "bolt.circle"
        case .disableAutoMerge: "bolt.slash.circle"
        }
    }
}

private extension PullRequestReviewVerdict {
    var label: String {
        switch self {
        case .comment: "Comment"
        case .approve: "Approve"
        case .requestChanges: "Request changes"
        }
    }
}

private extension PullRequestMergeMethod {
    var label: String {
        switch self {
        case .merge: "Create merge commit"
        case .squash: "Squash and merge"
        case .rebase: "Rebase and merge"
        }
    }
}

private extension PullRequestReactionContent {
    var emoji: String {
        switch self {
        case .thumbsUp: "👍"
        case .thumbsDown: "👎"
        case .laugh: "😄"
        case .hooray: "🎉"
        case .confused: "😕"
        case .heart: "❤️"
        case .rocket: "🚀"
        case .eyes: "👀"
        }
    }
    var label: String { rawValue.replacingOccurrences(of: "-", with: " ").capitalized }
}

private extension PullRequestEditor.Kind {
    var title: String {
        switch self {
        case .title: "Edit Title"
        case .body: "Edit Description"
        case .comment: "Add Comment"
        }
    }
}
