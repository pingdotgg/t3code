import Observation
import SwiftUI

struct FeatureReviewGuideAccess: Equatable, Sendable {
    let enabled: Bool
    let canWrite: Bool
}

/// Optional so clients without review guides do not need placeholder methods.
@MainActor
protocol FeatureReviewGuideClient: AnyObject {
    func reviewGuideAccess(_ target: FeaturePullRequestTarget) async throws -> FeatureReviewGuideAccess
    func pullRequestReviewGuide(_ target: FeaturePullRequestTarget) async throws -> PullRequestReviewGuideResult
    func generatePullRequestReviewGuide(_ target: FeaturePullRequestTarget) async throws -> PullRequestReviewGuideResult
}

struct FeatureReviewGuideFileLocation: Equatable {
    let path: String
    let side: PullRequestReviewGuideExcerpt.Side?
    let start: Int?
    let end: Int?
    let guideHeadSha: String
}

struct FeatureReviewGuideStopSelection: Equatable {
    let headSha: String
    let generatedAt: String
    var position: Int

    func matches(_ guide: PullRequestReviewGuide) -> Bool {
        headSha == guide.headSha && generatedAt == guide.generatedAt
    }
}

enum FeatureReviewGuideTour {
    static func step(_ position: Int, by delta: Int, count: Int) -> Int {
        max(0, min(position + delta, count - 1))
    }

    static func paths(_ stop: PullRequestReviewGuideStop) -> [String] {
        var seen = Set<String>()
        return (stop.excerpts.map(\.path) + stop.files.map(\.path)).filter { seen.insert($0).inserted }
    }

    static func marker(_ index: Int) -> String {
        index < 26 ? String(UnicodeScalar(65 + index)!) : String(index + 1)
    }

    /// Keep replacement lines together, without crossing a hunk boundary.
    static func excerptLines(_ lines: [PullRequestDiffLine], excerpt: PullRequestReviewGuideExcerpt) -> [PullRequestDiffLine] {
        let inRange: (PullRequestDiffLine) -> Bool = { line in
            guard let number = excerpt.side == .new ? line.newLine : line.oldLine else { return false }
            return number >= excerpt.start && number <= excerpt.end && line.kind != .header
        }
        guard var first = lines.firstIndex(where: inRange), var last = lines.lastIndex(where: inRange) else { return [] }
        if excerpt.side == .new, lines[first].kind == .added {
            while first > 0, lines[first - 1].kind == .deleted { first -= 1 }
        }
        if excerpt.side == .old, lines[last].kind == .deleted {
            while last + 1 < lines.count, lines[last + 1].kind == .added { last += 1 }
        }
        return Array(lines[first...last]).filter { $0.kind != .header }
    }
}

@MainActor
@Observable
final class FeatureReviewGuideModel {
    private let client: any FeatureReviewGuideClient
    private let target: FeaturePullRequestTarget
    private var readGeneration = 0
    var access: FeatureReviewGuideAccess?
    var data: PullRequestReviewGuideResult?
    var isStarting = false
    var errorMessage: String?
    var startError: String?
    var observationID = 0

    init(client: any FeatureReviewGuideClient, target: FeaturePullRequestTarget) {
        self.client = client
        self.target = target
    }

    var running: Bool { isStarting || data?.isRunning == true }
    var canWrite: Bool { access?.enabled == true && access?.canWrite == true && !running }

    func refresh() async {
        readGeneration += 1
        let generation = readGeneration
        do {
            let access = try await client.reviewGuideAccess(target)
            guard !Task.isCancelled, generation == readGeneration else { return }
            self.access = access
            guard access.enabled else {
                data = nil
                errorMessage = nil
                return
            }
            let result = try await client.pullRequestReviewGuide(target)
            guard !Task.isCancelled, generation == readGeneration else { return }
            data = result
            errorMessage = nil
        } catch {
            guard !Task.isCancelled, generation == readGeneration else { return }
            errorMessage = error.localizedDescription
        }
    }

    /// The view's task owns polling, so leaving the screen stops reads.
    func observe() async {
        await refresh()
        while !Task.isCancelled, access?.enabled == true, data?.isRunning == true {
            do { try await Task.sleep(for: .seconds(5)) }
            catch { return }
            await refresh()
        }
    }

    func generate() async {
        guard canWrite else { return }
        isStarting = true
        startError = nil
        defer { isStarting = false }
        do {
            let access = try await client.reviewGuideAccess(target)
            self.access = access
            guard access.enabled, access.canWrite else { return }
            let result = try await client.generatePullRequestReviewGuide(target)
            guard !Task.isCancelled else { return }
            readGeneration += 1
            data = result
            errorMessage = nil
            observationID += 1
        } catch {
            guard !Task.isCancelled else { return }
            startError = error.localizedDescription
        }
    }
}

/// Mount inside the existing PR detail navigation. File and review routing stay with its owner.
struct FeatureReviewGuideView: View {
    private let client: any FeatureClient
    private let target: FeaturePullRequestTarget
    private let onOpenFile: (FeatureReviewGuideFileLocation) -> Void
    private let onFinish: ((String) -> Void)?
    private let boundSelection: Binding<FeatureReviewGuideStopSelection?>?
    @State private var model: FeatureReviewGuideModel?
    @State private var localSelection: FeatureReviewGuideStopSelection?
    @SwiftUI.Environment(\.scenePhase) private var scenePhase

    init(client: any FeatureClient, target: FeaturePullRequestTarget,
         selection: Binding<FeatureReviewGuideStopSelection?>? = nil,
         onOpenFile: @escaping (FeatureReviewGuideFileLocation) -> Void,
         onFinish: ((String) -> Void)? = nil) {
        self.client = client
        self.target = target
        boundSelection = selection
        self.onOpenFile = onOpenFile
        self.onFinish = onFinish
        _model = State(initialValue: (client as? any FeatureReviewGuideClient).map {
            FeatureReviewGuideModel(client: $0, target: target)
        })
    }

    private var selection: FeatureReviewGuideStopSelection? {
        get {
            if let boundSelection { return boundSelection.wrappedValue }
            return localSelection
        }
        nonmutating set {
            if let boundSelection { boundSelection.wrappedValue = newValue }
            else { localSelection = newValue }
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if let model {
                    if model.access?.enabled == false {
                        Text("Review guides are disabled for this server.")
                    } else {
                        notice(model)
                        if let guide = model.data?.guide {
                            if let selection {
                                if selection.matches(guide), guide.stops.indices.contains(selection.position) {
                                    stop(guide, selection: selection, model: model)
                                } else {
                                    Text("This guide was rewritten. Return to the outline to start the new tour.")
                                    Button("Back to outline") { self.selection = nil }
                                }
                            } else {
                                outline(guide, model: model)
                            }
                        }
                    }
                } else {
                    Text("Review guides are not available on this client.")
                }
            }
            .frame(maxWidth: 760, alignment: .leading)
            .padding()
            .frame(maxWidth: .infinity)
        }
        .foregroundStyle(T3Colors.textPrimary)
        .background(T3Colors.background)
        .navigationTitle(selection.map { "Stop \($0.position + 1)" } ?? "Review guide")
        .task(id: "\(scenePhase):\(model?.observationID ?? 0):\(model?.data?.isRunning == true)") {
            guard scenePhase == .active else { return }
            await model?.observe()
        }
        .refreshable { await model?.refresh() }
    }

    @ViewBuilder
    private func notice(_ model: FeatureReviewGuideModel) -> some View {
        if model.running {
            Label(model.data?.guide == nil ? "Writing guide…" : "Rewriting guide…", systemImage: "clock")
            Text(model.data?.guide == nil
                 ? "An agent is reading the change. You can leave and return when the guide is ready."
                 : "You can keep reading while the agent writes the update.")
        } else if let failure = model.startError ?? model.data?.failure {
            Text("Could not write guide").font(.headline)
            Text(failure).foregroundStyle(T3Colors.danger)
            writeAction("Try again", model: model)
        } else if let error = model.errorMessage {
            Text("Could not refresh guide").font(.headline)
            Text(error).foregroundStyle(T3Colors.danger)
            Button("Try again") { Task { await model.refresh() } }
        } else if model.data == nil {
            Label("Checking for a saved guide…", systemImage: "clock")
        } else if model.data?.isStale == true {
            Text("New changes since this guide").font(.headline)
            Text("Read the previous guide, or rewrite it for the latest changes.")
            writeAction("Rewrite guide", model: model)
        } else if model.data?.guide == nil {
            Text("Get a tour of the change, with code excerpts and notes for review.")
            writeAction("Write guide", model: model)
        }
    }

    @ViewBuilder
    private func writeAction(_ title: String, model: FeatureReviewGuideModel) -> some View {
        if model.canWrite {
            Button(title) { Task { await model.generate() } }
        } else {
            Text("Writing a guide requires a connection and write access.")
                .font(.footnote).foregroundStyle(T3Colors.textSecondary)
        }
    }

    private func outline(_ guide: PullRequestReviewGuide, model: FeatureReviewGuideModel) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            let count = Set(guide.stops.flatMap(FeatureReviewGuideTour.paths)).count
            HStack {
                Text("\(guide.stops.count) stops through \(count) \(count == 1 ? "file" : "files")").font(.headline)
                Spacer()
                if model.canWrite, model.data?.isStale != true, model.startError == nil, model.errorMessage == nil {
                    Button("Rewrite guide") { Task { await model.generate() } }
                }
            }
            if let summary = guide.stops.first?.summary {
                MarkdownMessageView(summary, copyActionTitle: "Copy guide summary")
            }
            ForEach(guide.stops.indices, id: \.self) { index in
                Button {
                    selection = .init(headSha: guide.headSha, generatedAt: guide.generatedAt, position: index)
                } label: {
                    HStack(alignment: .top, spacing: 12) {
                        Text("\(index + 1)").monospacedDigit()
                        VStack(alignment: .leading, spacing: 4) {
                            Text(guide.stops[index].title).font(.headline)
                            let paths = FeatureReviewGuideTour.paths(guide.stops[index])
                            Text(paths.isEmpty ? "Context, no code" : paths.joined(separator: ", "))
                                .font(.caption).foregroundStyle(T3Colors.textSecondary)
                        }
                        Spacer()
                        if guide.stops[index].attention != nil {
                            Image(systemName: "eye").accessibilityLabel("Needs a closer look")
                        }
                        Image(systemName: "chevron.right")
                    }
                    .frame(minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Stop \(index + 1): \(guide.stops[index].title)")
                Divider()
            }
        }
    }

    private func stop(_ guide: PullRequestReviewGuide, selection: FeatureReviewGuideStopSelection,
                      model: FeatureReviewGuideModel) -> some View {
        let stop = guide.stops[selection.position]
        return VStack(alignment: .leading, spacing: 20) {
            Button("Back to outline") { self.selection = nil }
            Text(stop.title).font(.title2.bold())
            MarkdownMessageView(stop.summary, copyActionTitle: "Copy stop summary")
            if let attention = stop.attention {
                Label(attention.kind.label, systemImage: "eye").font(.headline)
                MarkdownMessageView(attention.note, copyActionTitle: "Copy review attention")
            }
            if model.data?.isStale == true {
                Text("Excerpts are hidden until the guide is rewritten for the current head.")
                    .foregroundStyle(T3Colors.textSecondary)
            } else {
                FeatureReviewGuideExcerpts(client: client, target: target, guide: guide, stop: stop,
                                          onOpenFile: onOpenFile)
                    .id("\(guide.headSha):\(guide.generatedAt):\(selection.position)")
            }
            if !stop.notes.isEmpty {
                Text("Notes on this stop").font(.headline)
                ForEach(stop.notes.indices, id: \.self) { index in
                    let note = stop.notes[index]
                    HStack(alignment: .top, spacing: 12) {
                        Text(FeatureReviewGuideTour.marker(index)).font(.caption.monospaced().bold())
                        VStack(alignment: .leading, spacing: 8) {
                            Text(note.title).font(.headline)
                            Text("\(note.path):\(note.line)").font(.caption).foregroundStyle(T3Colors.textSecondary)
                            MarkdownMessageView(note.body, copyActionTitle: "Copy review note")
                        }
                    }
                }
            }
            ForEach(stop.files.indices, id: \.self) { index in
                let file = stop.files[index]
                Button {
                    onOpenFile(.init(path: file.path, side: nil, start: nil, end: nil, guideHeadSha: guide.headSha))
                } label: {
                    Label(file.path, systemImage: "doc.text").frame(minHeight: 44)
                }
                if let note = file.note { MarkdownMessageView(note, copyActionTitle: "Copy file note") }
            }
            if !stop.questions.isEmpty {
                Text("Questions to consider").font(.headline)
                ForEach(stop.questions.indices, id: \.self) { index in
                    MarkdownMessageView(stop.questions[index], copyActionTitle: "Copy question")
                }
            }
            Divider()
            HStack {
                if selection.position > 0 {
                    Button("Previous stop") { self.selection?.position = FeatureReviewGuideTour.step(selection.position, by: -1, count: guide.stops.count) }
                }
                Spacer()
                if selection.position + 1 < guide.stops.count {
                    Button("Next stop") { self.selection?.position = FeatureReviewGuideTour.step(selection.position, by: 1, count: guide.stops.count) }
                } else if let onFinish, model.data?.isStale != true {
                    Button("Finish review") { onFinish(guide.headSha) }
                } else {
                    Button("Finish tour") { self.selection = nil }
                }
            }
        }
    }
}

private struct FeatureReviewGuideExcerpts: View {
    let client: any FeatureClient
    let target: FeaturePullRequestTarget
    let guide: PullRequestReviewGuide
    let stop: PullRequestReviewGuideStop
    let onOpenFile: (FeatureReviewGuideFileLocation) -> Void
    @State private var files: [PullRequestDiffFile] = []
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var retryID = 0
    @AppStorage("swift-ios.review-guide.word-wrap") private var wordWrap = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if !stop.excerpts.isEmpty {
                Toggle("Wrap code", isOn: $wordWrap).font(.footnote)
            }
            ForEach(stop.excerpts.indices, id: \.self) { index in
                let excerpt = stop.excerpts[index]
                let file = files.first { $0.path == excerpt.path || $0.oldPath == excerpt.path }
                let lines = FeatureReviewGuideTour.excerptLines(file?.lines ?? [], excerpt: excerpt)
                VStack(alignment: .leading, spacing: 8) {
                    if !excerpt.caption.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        MarkdownMessageView(excerpt.caption, copyActionTitle: "Copy excerpt caption")
                    }
                    Button {
                        onOpenFile(.init(path: excerpt.path, side: excerpt.side, start: excerpt.start,
                                         end: excerpt.end, guideHeadSha: guide.headSha))
                    } label: {
                        Label("\(excerpt.path):\(excerpt.start)–\(excerpt.end)", systemImage: "arrow.up.right")
                            .font(.caption.monospaced()).frame(minHeight: 44)
                    }
                    .accessibilityLabel("Open \(excerpt.path) at line \(excerpt.start) in full diff")
                    if lines.isEmpty {
                        Text(isLoading ? "Loading excerpt…" : "This excerpt is not in the loaded diff.")
                            .font(.caption).foregroundStyle(T3Colors.textSecondary)
                    } else if wordWrap {
                        code(lines)
                    } else {
                        ScrollView(.horizontal) { code(lines).fixedSize(horizontal: true, vertical: false) }
                    }
                }
                Divider()
            }
            if let errorMessage {
                Text(errorMessage).foregroundStyle(T3Colors.danger)
                Button("Retry excerpts") { retryID += 1 }
            }
        }
        .task(id: retryID) { await load() }
    }

    private func code(_ lines: [PullRequestDiffLine]) -> some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(lines) { line in
                HStack(alignment: .top, spacing: 10) {
                    Text(line.oldLine.map(String.init) ?? " ").frame(width: 36, alignment: .trailing)
                    Text(line.newLine.map(String.init) ?? " ").frame(width: 36, alignment: .trailing)
                    Text(line.text).frame(maxWidth: .infinity, alignment: .leading)
                }
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(line.foreground)
                .padding(.vertical, 2)
                .background(line.background)
            }
        }
        .textSelection(.enabled)
    }

    @MainActor
    private func load() async {
        guard !stop.excerpts.isEmpty else { isLoading = false; return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        var pagination = PullRequestDiffPagination()
        var cursor: String?
        let wanted = Set(stop.excerpts.map(\.path))
        do {
            repeat {
                let page = try await client.pullRequestDiff(target, cursor: cursor)
                try Task.checkCancellation()
                cursor = pagination.append(page)
                let patch = pagination.patch
                let parsed = await Task.detached(priority: .userInitiated) {
                    PullRequestDiffParser.parse(patch)
                }.value
                try Task.checkCancellation()
                files = parsed
                let loaded = Set(files.flatMap { [$0.path] + [$0.oldPath].compactMap { $0 } })
                if wanted.isSubset(of: loaded) { return }
            } while cursor != nil
        } catch {
            if !Task.isCancelled { errorMessage = error.localizedDescription }
        }
    }
}

private extension PullRequestReviewGuideAttention.Kind {
    var label: String {
        switch self {
        case .tradeoff: "A tradeoff to weigh"
        case .contract: "A contract to check"
        case .product: "A product decision"
        case .risk: "A risk to judge"
        case .accessibility: "An accessibility decision"
        }
    }
}
