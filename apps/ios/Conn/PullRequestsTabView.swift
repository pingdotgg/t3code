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
                        Text("\(selected.count) open · \(selected.filter { $0.checksState == "pending" }.count) in progress")
                            .font(.caption).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity)
                    Menu {
                        ForEach(["All", "Checks running", "Checks passed", "Checks failed", "Draft"], id: \.self) { option in
                            Button("\(option) (\(candidates.filter { option == "All" || $0.status == option }.count))") { filter = option }
                        }
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
                        HStack(spacing: 12) {
                            ProjectFaviconView(title: row.projectTitle, size: 18)
                                .overlay(alignment: .topTrailing) {
                                    Circle().fill(row.checksState == "failing" ? theme.destructive : row.checksState == "passing" ? theme.success : row.checksState == "pending" ? theme.warning : theme.mutedForeground)
                                        .frame(width: 6, height: 6).padding(2)
                                        .background(theme.background, in: Circle()).offset(x: 4, y: -4)
                                }
                            VStack(alignment: .leading, spacing: 4) {
                                Text(row.title).font(.system(size: 16, weight: .medium)).lineLimit(2)
                                Text("\(row.projectTitle) · #\(row.number) · \(row.status)").font(.subheadline).foregroundStyle(.secondary)
                            }
                            Spacer()
                        }.padding(.vertical, 8).contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityIdentifier("pr.row.\(row.repository).\(row.number)")
                }
            }.padding(.horizontal, 16)
        }
        .background(theme.background)
        .refreshable { await load() }
        .task(id: store.environmentId) { await load() }
    }

    private func load() async {
        loading = true
        defer { if !Task.isCancelled { loading = false } }
        do {
            var input: [String: Any] = ["state": "open"]
            var result: [PullRequestRow] = []
            var seen = Set<String>()
            var messages = Set<String>()
            var previous = Set<[String: String]>()
            while true {
                let page = try await store.pullRequest(.list, input: input, as: PullRequestPage.self)
                try Task.checkCancellation()
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
        } catch {
            if !Task.isCancelled { notice = error.localizedDescription }
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
        struct Permissions: Decodable { let verdicts: [String] }
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
        struct Thread: Decodable { let comments: [Comment] }
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
    struct FileChange {
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
    @State private var omitted: [String] = []
    @State private var canReadOmitted = false
    @State private var truncated = false
    @State private var submitting = false

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
                                NavigationLink {
                                    ScrollView { PatchBody(patch: change.patch) }
                                        .navigationTitle(path.lastPathComponent)
                                        .toolbar(.hidden, for: .bottomBar)
                                        .accessibilityIdentifier("pr.fileDiff")
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
                                    }.font(.subheadline).lineLimit(1)
                                }.buttonStyle(.plain).accessibilityIdentifier("pr.file.\(change.patch.path)")
                            }
                            ForEach(omitted, id: \.self) { path in
                                if canReadOmitted {
                                    NavigationLink(path) { OmittedPatch(store: store, row: row, path: path) }
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

private struct OmittedPatch: View {
    let store: CoreStore
    let row: PullRequestRow
    let path: String
    @State private var patch: FfiFilePatch?
    @State private var error: String?

    var body: some View {
        ScrollView {
            if let patch { PatchBody(patch: patch) }
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
                patch = await Task.detached { parseFilePatches(patch: page.patch).first }.value
                if patch == nil { error = "No diff available" }
            } catch { self.error = error.localizedDescription }
        }
    }
}
