import SwiftUI

struct PullRequestRow: Codable, Identifiable, Hashable {
    let projectId, projectTitle, host, repository, title, url, headBranch, baseBranch: String
    let number: Int
    let isDraft: Bool
    struct Actor: Codable, Hashable { let login: String }
    struct LabelValue: Codable, Hashable { let name: String }
    let author: Actor?
    let labels: [LabelValue]?
    let checksState: String?
    var id: String { url }
    var ref: [String: Any] {
        ["projectId": projectId, "host": host, "repository": repository, "number": number]
    }
    var status: String {
        if isDraft { return "Draft" }
        switch checksState {
        case "pending": return "Checks running"
        case "passing": return "Checks passed"
        case "failing": return "Checks failed"
        default: return "Open"
        }
    }
}

private struct PullRequestStats: Decodable {
    struct Stat: Decodable {
        let projectId, repository: String
        let number, additions, deletions: Int
    }
    let stats: [Stat]
}

private struct PullRequestPage: Decodable {
    struct ProjectError: Decodable { let projectTitle, message: String }
    let entries: [PullRequestRow]
    let errors: [ProjectError]
    let nextCursors: [String: String]
    let truncated: Bool
}

struct PullRequestsTabView: View {
    let store: CoreStore
    let searchQuery: String
    @State private var rows: [PullRequestRow] = []
    @State private var stats: [String: PullRequestStats.Stat] = [:]
    @State private var request = UUID()
    @State private var notice: String?
    @State private var loading = true
    @State private var filter = "All"
    @Environment(\.connTheme) private var theme

    var body: some View {
        let candidates = rows.filter { row in
            searchQuery.isEmpty || [row.title, row.repository, row.projectTitle, "#\(row.number)", row.headBranch, row.author?.login ?? "", row.labels?.map(\.name).joined(separator: " ") ?? ""]
                .joined(separator: " ").localizedCaseInsensitiveContains(searchQuery)
        }
        let selected = candidates.filter { filter == "All" || $0.status == filter }
        ScrollView {
            LazyVStack(spacing: 0) {
                ZStack(alignment: .trailing) {
                    VStack(spacing: 0) {
                        Text("Pull Requests").font(.system(size: 18, weight: .medium))
                        Text("\(selected.count) open · \(selected.filter { $0.status == "Checks running" }.count) in progress")
                            .font(.caption).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity)
                    Menu {
                        Picker("Status", selection: $filter) {
                            ForEach(["All", "Checks running", "Checks passed", "Checks failed", "Draft"], id: \.self) { option in
                                let label = option == "Checks running" ? "In progress" : option
                                Text("\(label) (\(candidates.filter { option == "All" || $0.status == option }.count))").tag(option)
                            }
                        }.pickerStyle(.inline)
                    } label: { Image(systemName: "line.3.horizontal.decrease").frame(width: 44, height: 44) }
                    .accessibilityLabel("Filter pull requests")
                }.frame(height: 56)
                if loading { ProgressView() }
                if let notice { Text(notice).foregroundStyle(.secondary).padding() }
                if !loading && notice == nil && selected.isEmpty {
                    Text(candidates.isEmpty && searchQuery.isEmpty ? "No open pull requests" : "No matching pull requests")
                        .foregroundStyle(.secondary).padding()
                }
                ForEach(selected) { row in
                    NavigationLink(value: WorkspaceRoute.pullRequest(row)) {
                        HStack(alignment: .top, spacing: 12) {
                            ProjectFaviconView(title: row.projectTitle, size: 20)
                                .overlay(alignment: .topTrailing) {
                                    Circle().fill(row.checksState == "failing" ? theme.destructive : row.checksState == "passing" ? theme.success : row.checksState == "pending" ? theme.warning : theme.mutedForeground)
                                        .frame(width: 6, height: 6).padding(2)
                                        .background(theme.background, in: Circle()).offset(x: 4, y: -4)
                                }
                            VStack(alignment: .leading, spacing: 4) {
                                HStack(spacing: 6) {
                                    Text(row.title).font(.system(size: 16, weight: .medium)).lineLimit(1)
                                    Spacer(minLength: 0)
                                    if let stat = stats[row.id] {
                                        HStack(spacing: 4) {
                                            Text("+\(stat.additions)").foregroundStyle(theme.diffAdded)
                                            Text("−\(stat.deletions)").foregroundStyle(theme.diffRemoved)
                                        }.font(.caption.monospacedDigit()).fixedSize()
                                    }
                                }
                                Text("\(row.projectTitle) · #\(row.number) · \(row.status)").font(.subheadline).foregroundStyle(.secondary)
                            }
                            Spacer()
                        }.padding(.vertical, 12).contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityIdentifier("pr.row.\(row.repository).\(row.number)")
                }
            }.padding(.horizontal, 12)
        }
        .background(theme.background)
        .refreshable { await load() }
        .task(id: store.environmentId) { await load() }
    }

    private func load() async {
        let generation = UUID()
        request = generation
        loading = true
        defer { if request == generation && !Task.isCancelled { loading = false } }
        do {
            var input: [String: Any] = ["state": "open"]
            var result: [PullRequestRow] = []
            var seen = Set<String>()
            var messages = Set<String>()
            var previous = Set<[String: String]>()
            while true {
                let page = try await store.pullRequest(.list, input: input, as: PullRequestPage.self)
                try Task.checkCancellation()
                guard request == generation else { return }
                result += page.entries.filter { seen.insert($0.id).inserted }
                for error in page.errors { messages.insert("\(error.projectTitle): \(error.message)") }
                guard page.truncated else { break }
                guard !page.nextCursors.isEmpty, previous.insert(page.nextCursors).inserted else {
                    messages.insert("Showing a partial list.")
                    break
                }
                input["cursors"] = page.nextCursors
            }
            rows = result
            notice = messages.isEmpty ? nil : messages.sorted().joined(separator: "\n")
            loading = false
            stats = [:]
            for start in stride(from: 0, to: result.count, by: 100) {
                let batch = result[start..<min(start + 100, result.count)]
                guard let response = try? await store.pullRequest(.listStats, input: ["refs": batch.map(\.ref)], as: PullRequestStats.self) else { break }
                guard request == generation && !Task.isCancelled else { return }
                for stat in response.stats {
                    if let row = batch.first(where: { $0.projectId == stat.projectId && $0.repository == stat.repository && $0.number == stat.number }) {
                        stats[row.id] = stat
                    }
                }
            }
        } catch {
            if request == generation && !Task.isCancelled { notice = error.localizedDescription }
        }
    }
}

struct PullRequestRecord: View {
    struct Detail: Decodable {
        struct Check: Decodable {
            let name, status: String
            let description: String?
            let placeholder: Bool?
        }
        struct Permissions: Decodable { let verdicts: [String]; let comment: Bool?; let inlineComment: Bool? }
        struct Capabilities: Decodable { let review: Permissions; let diff: Bool }
        let title, body: String
        let additions, deletions, changedFiles: Int
        let checks: [Check]
        let viewerPermissions: Permissions
        let capabilities: Capabilities
    }
    struct Activity: Decodable {
        struct Comment: Decodable { let id, body, createdAt: String }
        struct Commit: Decodable { let oid, messageHeadline, committedDate: String }
        struct Thread: Decodable {
            let path, side: String?
            let line: UInt32?
            let isOutdated: Bool
            let comments: [Comment]
        }
        let comments: [Comment]
        let reviewThreads: [Thread]
        let overviewThreads: [Thread]?
        let commits: [Commit]
    }
    struct DiffPage: Decodable {
        struct Omitted: Decodable { let path: String }
        let patch: String
        let nextCursor: String?
        let truncated: Bool
        let omittedFileStats: [Omitted]?
        let withheldFilesReadable: Bool?
    }
    let store: CoreStore
    let row: PullRequestRow
    @State private var section = "Overview"
    @State private var detail: Detail?
    @State private var activity: Activity?
    @State private var failure: String?
    @State private var checkFilter = "All"
    @State private var attempt = 0
    @State private var review: String?
    @State private var bodyText = ""
    struct FileChange: Identifiable {
        var id: String { patch.path }
        let patch: FfiFilePatch
        let additions: Int
        let deletions: Int

        init(_ patch: FfiFilePatch) {
            self.patch = patch
            additions = patch.lines.count { $0.marker == "+" }
            deletions = patch.lines.count { $0.marker == "-" }
        }
    }
    @State private var patches: [FileChange]?
    @State private var selectedFile: FileChange?
    @State private var omitted: [String] = []
    @State private var canReadOmitted = false
    @State private var truncated = false
    @State private var submitting = false

    private var canCommentOnFile: Bool {
        detail?.capabilities.review.inlineComment == true &&
        detail?.viewerPermissions.comment == true &&
        detail?.capabilities.review.verdicts.contains("comment") == true &&
        detail?.viewerPermissions.verdicts.contains("comment") == true
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(row.title).font(.title2.weight(.semibold))
                if let failure { Text(failure); Button("Try again") { attempt += 1 } }
                if let detail {
                    switch section {
                    case "Checks":
                        let checks = detail.checks.filter { $0.placeholder != true }
                        Picker("Status", selection: $checkFilter) {
                            ForEach(["All"] + Set(checks.map(\.status)).sorted(), id: \.self) { status in
                                Text("\(status.capitalized) (\(checks.filter { status == "All" || $0.status == status }.count))").tag(status)
                            }
                        }
                        ForEach(Array(checks.enumerated()), id: \.offset) { _, check in
                            if checkFilter == "All" || check.status == checkFilter {
                                LabeledContent(check.name, value: check.status.capitalized)
                                if let description = check.description { Text(description).foregroundStyle(.secondary) }
                            }
                        }
                    case "Files":
                        if let patches {
                            ForEach(patches, id: \.patch.path) { change in
                                let path = change.patch.path as NSString
                                Button {
                                    selectedFile = change
                                } label: {
                                    HStack(spacing: 10) {
                                        Image(systemName: "doc.text")
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(path.lastPathComponent).fontWeight(.medium)
                                            if !path.deletingLastPathComponent.isEmpty {
                                                Text(path.deletingLastPathComponent).font(.caption).foregroundStyle(.secondary)
                                            }
                                        }
                                        Spacer()
                                        Text("+\(change.additions)").foregroundStyle(.green)
                                        Text("−\(change.deletions)").foregroundStyle(.red)
                                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary)
                                    }.font(.subheadline).lineLimit(1).contentShape(Rectangle())
                                }.buttonStyle(.plain).accessibilityIdentifier("pr.file.\(change.patch.path)")
                            }
                            ForEach(omitted, id: \.self) { path in
                                if canReadOmitted {
                                    NavigationLink(path) { OmittedPatch(store: store, row: row, path: path, canComment: canCommentOnFile) }
                                } else { LabeledContent(path, value: "Diff unavailable") }
                            }
                            if truncated { Text("Some changes were omitted by the host.").foregroundStyle(.secondary) }
                            if patches.isEmpty && omitted.isEmpty && !truncated { Text("No changed files") }
                        } else if failure == nil { ProgressView() }
                    case "Timeline":
                        if let activity {
                            let comments = activity.comments + (activity.reviewThreads + (activity.overviewThreads ?? [])).flatMap(\.comments)
                            let events = Dictionary(grouping: comments, by: \.id).values.compactMap(\.first).map { ($0.createdAt, $0.id, $0.body) }
                                + activity.commits.map { ($0.committedDate, $0.oid, $0.messageHeadline) }
                            if events.isEmpty { Text("No activity").accessibilityIdentifier("pr.timeline.empty") }
                            ForEach(events.sorted { $0.0 < $1.0 }, id: \.1) { event in
                                VStack(alignment: .leading) {
                                    Text(event.0).font(.caption).foregroundStyle(.secondary)
                                    MarkdownView(source: event.2)
                                }.accessibilityElement(children: .combine).accessibilityIdentifier("pr.timeline.event")
                            }
                        } else if failure == nil { ProgressView() }
                    default:
                        if let author = row.author { LabeledContent("Author", value: author.login) }
                        LabeledContent("Status", value: row.status)
                        LabeledContent("Repository", value: row.repository)
                        LabeledContent("Branch", value: "\(row.headBranch) → \(row.baseBranch)")
                        LabeledContent("Changes", value: "+\(detail.additions) −\(detail.deletions) · \(detail.changedFiles) files")
                        MarkdownView(source: detail.body)
                        let verdicts = detail.viewerPermissions.verdicts.filter { detail.capabilities.review.verdicts.contains($0) }
                        if !verdicts.isEmpty {
                            Menu("Review") {
                                ForEach(verdicts, id: \.self) { verdict in
                                    Button(verdict.replacingOccurrences(of: "-", with: " ").capitalized) { review = verdict }
                                }
                            }.disabled(submitting)
                        }
                    }
                } else if failure == nil { ProgressView() }
            }.padding().frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle("Pull Request #\(row.number)")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItemGroup(placement: .bottomBar) {
                ForEach(["Overview", "Checks", "Timeline"] + (detail?.capabilities.diff == true ? ["Files"] : []), id: \.self) { name in
                    Button { section = name } label: {
                        Image(systemName: name == "Overview" ? "doc.text" : name == "Checks" ? "checkmark.circle" : name == "Files" ? "doc.on.doc" : "clock")
                    }.tint(name == section ? .accentColor : .secondary).accessibilityLabel(name).accessibilityAddTraits(name == section ? .isSelected : [])
                }
            }
        }
        .navigationDestination(isPresented: Binding(get: { selectedFile != nil }, set: { if !$0 { selectedFile = nil } })) {
            if let file = selectedFile {
                ReviewFileView(store: store, row: row, file: file, canComment: canCommentOnFile)
            }
        }
        .alert("Submit review", isPresented: Binding(get: { review != nil }, set: { if !$0 { review = nil } })) {
            TextField("Comment", text: $bodyText)
            Button("Cancel", role: .cancel) {}
            Button("Submit") {
                guard let verdict = review else { return }
                submitting = true
                Task {
                    defer { submitting = false }
                    do {
                        typealias Result = Bool?
                        var input = row.ref
                        input["verdict"] = verdict
                        input["body"] = bodyText
                        input["comments"] = [String]()
                        _ = try await store.pullRequest(.submitReview, input: input, as: Result.self)
                        bodyText = ""
                        attempt += 1
                    } catch { failure = error.localizedDescription }
                }
            }
        }
        .task(id: "\(section)-\(attempt)") {
            failure = nil
            do {
                if detail == nil || section == "Overview" {
                    detail = try await store.pullRequest(.detail, input: row.ref, as: Detail.self)
                }
                if section == "Files" && patches == nil {
                    var input = row.ref
                    var result: [FfiFilePatch] = []
                    var paths = Set<String>()
                    var incomplete = false
                    var cursors = Set<String>()
                    repeat {
                        let page = try await store.pullRequest(.diff, input: input, as: DiffPage.self)
                        try Task.checkCancellation()
                        result += await Task.detached { parseFilePatches(patch: page.patch) }.value
                        paths.formUnion(page.omittedFileStats?.map(\.path) ?? [])
                        if let readable = page.withheldFilesReadable { canReadOmitted = readable }
                        incomplete = incomplete || page.truncated
                        guard let cursor = page.nextCursor, cursors.insert(cursor).inserted else { break }
                        input["cursor"] = cursor
                    } while true
                    omitted = paths.subtracting(result.map(\.path)).sorted()
                    truncated = incomplete
                    patches = await Task.detached { [result] in result.map(FileChange.init) }.value
                }
                if section == "Timeline" {
                    activity = try await store.pullRequest(.activity, input: row.ref, as: Activity.self)
                }
            } catch { if !Task.isCancelled { failure = error.localizedDescription } }
        }
    }
}

private struct ReviewFileView: View {
    let store: CoreStore
    let row: PullRequestRow
    let file: PullRequestRecord.FileChange
    let canComment: Bool
    @State private var line: FfiPatchLine?
    @State private var draft = ""
    @State private var sending = false
    @State private var comments: [String: [String]] = [:]
    @State private var revision = 0
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading) {
                if let error, line == nil { Text(error).foregroundStyle(.secondary) }
                PatchBody(patch: file.patch, comments: comments, comment: canComment && store.status == .connected ? { line = $0 } : nil)
            }
        }
        .task(id: revision) {
            do {
                let activity = try await store.pullRequest(.activity, input: row.ref, as: PullRequestRecord.Activity.self)
                var anchored: [String: [String]] = [:]
                for thread in activity.reviewThreads where !thread.isOutdated {
                    guard let line = thread.line, let side = thread.side,
                          thread.path == (file.patch.newPath ?? file.patch.oldPath) || (side == "left" && thread.path == file.patch.oldPath) else { continue }
                    anchored[side + String(line), default: []] += thread.comments.map(\.body)
                }
                comments = anchored
            } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
        }
        .navigationTitle((file.patch.path as NSString).lastPathComponent)
        .toolbar(.hidden, for: .bottomBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text((file.patch.path as NSString).lastPathComponent).font(.headline).lineLimit(1)
                    HStack(spacing: 5) {
                        if file.additions > 0 { Text("+\(file.additions)").foregroundStyle(.green) }
                        if file.deletions > 0 { Text("−\(file.deletions)").foregroundStyle(.red) }
                    }.font(.caption.monospacedDigit())
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            if store.status != .connected { OfflinePill().padding(.bottom, 8) }
        }
        .sheet(isPresented: Binding(get: { line != nil }, set: { if !$0 { line = nil } })) {
            NavigationStack {
                Form {
                    TextField("Comment", text: $draft, axis: .vertical)
                    if let error { Text(error).foregroundStyle(.red) }
                }
                .navigationTitle("Comment on line " + String(line?.number ?? 0))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { line = nil; draft = ""; error = nil }.disabled(sending)
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Submit") { Task { await submit() } }
                            .disabled(sending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }.interactiveDismissDisabled(!draft.isEmpty || sending)
        }
    }

    private func submit() async {
        guard !sending, let line else { return }
        let position: [String: Any]
        switch (line.oldLine, line.newLine) {
        case let (old?, new?): position = ["kind": "context", "oldLine": old, "newLine": new, "side": "right"]
        case let (nil, new?): position = ["kind": "added", "newLine": new]
        case let (old?, nil): position = ["kind": "deleted", "oldLine": old]
        case (nil, nil): return
        }
        guard let path = file.patch.newPath ?? file.patch.oldPath else { return }
        var comment: [String: Any] = ["path": path, "position": position, "body": draft]
        if let old = file.patch.oldPath, old != path { comment["oldPath"] = old }
        var input = row.ref
        input["verdict"] = "comment"
        input["body"] = ""
        input["comments"] = [comment]
        sending = true
        defer { sending = false }
        do {
            _ = try await store.pullRequest(.submitReview, input: input, as: Bool?.self)
            revision += 1
            self.line = nil
            draft = ""
            error = nil
        } catch { self.error = error.localizedDescription }
    }
}

private struct OmittedPatch: View {
    let store: CoreStore
    let row: PullRequestRow
    let path: String
    let canComment: Bool
    @State private var change: PullRequestRecord.FileChange?
    @State private var error: String?

    var body: some View {
        Group {
            if let change { ReviewFileView(store: store, row: row, file: change, canComment: canComment) }
            else if let error { Text(error) }
            else { ProgressView() }
        }
        .navigationTitle(path)
        .toolbar(.hidden, for: .bottomBar)
        .task {
            do {
                var input = row.ref
                input["path"] = path
                let page = try await store.pullRequest(.diff, input: input, as: PullRequestRecord.DiffPage.self)
                change = await Task.detached { parseFilePatches(patch: page.patch).first.map(PullRequestRecord.FileChange.init) }.value
                if change == nil { error = "No diff available" }
            } catch { self.error = error.localizedDescription }
        }
    }
}
