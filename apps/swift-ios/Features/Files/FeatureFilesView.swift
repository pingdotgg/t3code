import SwiftUI
import UIKit

public struct FeatureFilesView: View {
    let client: any FeatureClient
    let threadID: String
    let initialPath: String?
    let initialLine: Int?
    let workspaceRoot: String?

    @State private var browser = FeatureFileBrowserState()

    public init(
        client: any FeatureClient,
        threadID: String,
        initialPath: String? = nil,
        initialLine: Int? = nil,
        workspaceRoot: String? = nil
    ) {
        self.client = client
        self.threadID = threadID
        self.initialPath = initialPath
        self.initialLine = initialLine
        self.workspaceRoot = workspaceRoot
    }

    public var body: some View {
        Group {
            if client.permissions(forThreadID: threadID)?.grants("filesystem:read") != true {
                ContentUnavailableView(
                    "Files unavailable", systemImage: "folder.badge.questionmark",
                    description: Text("This connection needs the filesystem:read permission.")
                )
            } else if let initialPath {
                FeatureFilePreviewView(
                    client: client,
                    threadID: threadID,
                    entry: FeatureFileEntry(
                        path: initialPath,
                        name: URL(fileURLWithPath: initialPath).lastPathComponent,
                        kind: .file
                    ),
                    workspaceRoot: workspaceRoot,
                    initialLine: initialLine
                )
                .id(FeatureFileBrowserState.Directory(
                    threadID: threadID, workspaceRoot: workspaceRoot, path: initialPath
                ))
                .id(initialLine)
            } else {
                FeatureFileDirectoryView(
                    client: client,
                    browser: browser,
                    threadID: threadID,
                    path: nil,
                    title: "Files",
                    workspaceRoot: workspaceRoot
                )
            }
        }
        .background(T3Colors.background)
    }
}

private struct FeatureFileDirectoryView: View {
    let client: any FeatureClient
    let browser: FeatureFileBrowserState
    let threadID: String
    let path: String?
    let title: String
    let workspaceRoot: String?

    @State private var searchText = ""
    @State private var search = FeatureFileSearchState()
    @State private var includesHidden = false

    private var directory: FeatureFileBrowserState.Directory {
        .init(threadID: threadID, workspaceRoot: workspaceRoot, path: path)
    }

    private var listing: FeatureFileBrowserState.Listing {
        browser.listing(for: directory)
    }

    private var searchRequest: FeatureFileSearchState.Request {
        .init(threadID: threadID, workspaceRoot: workspaceRoot, query: searchText)
    }

    private var isSearching: Bool { !searchRequest.query.isEmpty }
    private var isLoading: Bool {
        isSearching ? search.request != searchRequest || search.isLoading : listing.isLoading
    }
    private var errorMessage: String? {
        isSearching ? (search.request == searchRequest ? search.errorMessage : nil) : listing.errorMessage
    }

    var body: some View {
        let filteredEntries = self.filteredEntries
        List {
            if let errorMessage {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "exclamationmark.circle")
                        .foregroundStyle(T3Colors.warning)
                    Text(errorMessage)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button("Retry") { Task { await load(refresh: true) } }
                        .buttonStyle(.borderless)
                        .disabled(isLoading)
                }
            }
            if isLoading {
                Label(isSearching ? "Searching workspace…" : "Loading files…", systemImage: "folder")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                    .listRowBackground(Color.clear)
            } else if filteredEntries.isEmpty, errorMessage != nil {
                ContentUnavailableView(
                    "Files unavailable",
                    systemImage: "folder.badge.questionmark"
                )
                .listRowBackground(Color.clear)
            }
            if !isLoading, errorMessage == nil, filteredEntries.isEmpty {
                ContentUnavailableView(
                    isSearching ? "No matches" : "Empty folder",
                    systemImage: "folder",
                    description: Text(isSearching ? "Try another search." : "This folder has no visible files.")
                )
                .listRowBackground(Color.clear)
            }
            if isSearching, search.request == searchRequest, search.result?.isTruncated == true {
                Label("More matches available. Refine your search.", systemImage: "line.3.horizontal.decrease")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
            }
            ForEach(filteredEntries) { entry in
                NavigationLink {
                    destination(for: entry)
                } label: {
                    FeatureFileRow(entry: entry, showsPath: isSearching)
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .refreshable { await load(refresh: true) }
        .background(T3Colors.background)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $searchText, prompt: "Search workspace")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Toggle("Show hidden files", isOn: $includesHidden)
                    Button {
                        Task { await load(refresh: true) }
                    } label: {
                        Label("Reload", systemImage: "arrow.clockwise")
                    }
                } label: {
                    Image(systemName: "ellipsis")
                }
                .accessibilityLabel("File browser options")
            }
        }
        .task(id: directory) { await loadDirectory() }
        .task(id: searchRequest) { await loadSearch() }
    }

    @ViewBuilder
    private func destination(for entry: FeatureFileEntry) -> some View {
        if entry.kind == .directory {
            FeatureFileDirectoryView(
                client: client,
                browser: browser,
                threadID: threadID,
                path: entry.path,
                title: entry.name,
                workspaceRoot: workspaceRoot
            )
        } else {
            FeatureFilePreviewView(
                client: client,
                threadID: threadID,
                entry: entry,
                workspaceRoot: workspaceRoot
            )
            .id(FeatureFileBrowserState.Directory(
                threadID: threadID, workspaceRoot: workspaceRoot, path: entry.path
            ))
        }
    }

    private var filteredEntries: [FeatureFileEntry] {
        let entries = isSearching
            ? (search.request == searchRequest ? search.result?.entries ?? [] : [])
            : listing.entries ?? []
        // The server searches full paths and ranks matches. Do not filter its results by basename.
        return isSearching ? entries.filter { includesHidden || !$0.isHidden }
            : entries.featureFiltered(by: "", includesHidden: includesHidden)
    }

    private func load(refresh: Bool = false) async {
        if isSearching { await loadSearch(debounce: false) }
        else { await loadDirectory(refresh: refresh) }
    }

    private func loadSearch(debounce: Bool = true) async {
        await search.search(searchRequest, debounce: {
            if debounce { try await Task.sleep(for: .milliseconds(200)) }
        }) { query, limit in
            try (client.permissions(forThreadID: threadID) ?? EnvironmentPermissionState())
                .require("filesystem:read")
            if let searchClient = client as? any FeatureWorkspaceSearching {
                return try await searchClient.searchWorkspaceFiles(threadID: threadID, query: query, limit: limit)
            }
            let entries = try await client.searchThreadFiles(threadID: threadID, query: query, limit: limit)
            return FeatureFileSearchResult(entries: entries, isTruncated: entries.count >= limit)
        }
    }

    private func loadDirectory(refresh: Bool = false) async {
        await browser.load(directory, refresh: refresh) {
            try (client.permissions(forThreadID: threadID) ?? EnvironmentPermissionState())
                .require("filesystem:read")
            return try await client.listFiles(threadID: threadID, path: path)
        }
    }
}

private struct FeatureFileRow: View {
    let entry: FeatureFileEntry
    var showsPath = false

    var body: some View {
        HStack(spacing: 11) {
            Image(systemName: icon)
                .font(.system(size: 15))
                .foregroundStyle(entry.kind == .directory ? .blue : .secondary)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.name)
                    .font(T3Typography.threadBody)
                    .lineLimit(1)
                if showsPath, entry.path != entry.name {
                    Text(entry.path)
                        .font(T3Typography.tool)
                        .foregroundStyle(T3Colors.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            Spacer()
            if let size = entry.sizeBytes, entry.kind != .directory {
                Text(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))
                    .font(T3Typography.tool.monospacedDigit())
                    .foregroundStyle(T3Colors.textSecondary)
            }
        }
        .padding(.vertical, 3)
        .opacity(entry.isIgnored ? 0.55 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityValue(entry.isIgnored ? "Ignored by Git" : "")
    }

    private var icon: String {
        switch entry.kind {
        case .directory: "folder.fill"
        case .symbolicLink: "link"
        case .file:
            switch FeatureFilePreviewKind.infer(path: entry.path) {
            case .image: "photo"
            case .pdf: "doc.richtext"
            case .video: "video"
            case .audio: "waveform"
            case .browser: "globe"
            case .document: "doc"
            case .markdown: "doc.richtext"
            case .source: entry.name.hasSuffix(".swift") ? "swift" : "chevron.left.forwardslash.chevron.right"
            case .plainText: "doc.text"
            }
        }
    }
}

private struct FeatureFilePreviewView: View {
    let client: any FeatureClient
    let threadID: String
    let entry: FeatureFileEntry
    let workspaceRoot: String?
    let initialLine: Int?

    @SwiftUI.Environment(\.openURL) private var openURL
    @State private var mode: FeatureFileViewingMode
    @State private var wrapsLines = false
    @State private var refreshVersion = 0
    @State private var content: FeatureFileContent?
    @State private var sourceLines: [FeatureSourceLine] = []
    @State private var assetURL: URL?
    @State private var errorMessage: String?
    @State private var isLoading = true

    init(client: any FeatureClient, threadID: String, entry: FeatureFileEntry,
         workspaceRoot: String?, initialLine: Int? = nil) {
        self.client = client
        self.threadID = threadID
        self.entry = entry
        self.workspaceRoot = workspaceRoot
        self.initialLine = initialLine
        _mode = State(initialValue: FeatureFileViewingMode.initial(
            kind: .infer(path: entry.path), line: initialLine
        ))
    }

    private var previewKind: FeatureFilePreviewKind {
        FeatureFilePreviewKind.infer(path: entry.path, language: content?.language)
    }

    private var supportsPreview: Bool {
        FeatureWorkspacePreviewPolicy.supportsPreview(path: entry.path)
    }

    private var loadIdentity: FeatureFileLoadIdentity {
        .init(threadID: threadID, workspaceRoot: workspaceRoot, path: entry.path,
              mode: mode, refreshVersion: refreshVersion)
    }

    var body: some View {
        VStack(spacing: 0) {
            if let errorMessage {
                Text(errorMessage)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.warning)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
            }
            if isLoading, supportsPreview {
                Text("Loading file…")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
            }
            if !supportsPreview {
                ContentUnavailableView {
                    Label("Preview not supported", systemImage: "doc.badge.ellipsis")
                } description: {
                    Text("This file type cannot be previewed from the workspace.")
                } actions: {
                    Button("Copy path", systemImage: "doc.on.doc") {
                        UIPasteboard.general.string = entry.path
                    }
                    ShareLink(item: entry.path) {
                        Label("Share path", systemImage: "square.and.arrow.up")
                    }
                }
            } else if mode == .preview, let assetURL {
                FeatureNativeMediaPreviewView(
                    source: .remote(assetURL), kind: previewKind, fileName: entry.name,
                    resolveURL: { try await resolveAssetURL() }
                )
                .id(refreshVersion)
            } else if let content {
                if content.isTruncated {
                    Label("Partial preview", systemImage: "exclamationmark.triangle")
                        .font(T3Typography.supportingStrong)
                        .foregroundStyle(.orange)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                }
                if previewKind == .markdown, mode == .preview {
                    ScrollView {
                        MarkdownMessageView(
                            content.text, copyActionTitle: "Copy file contents",
                            imageContext: markdownImageContext
                        )
                        .frame(maxWidth: T3Metrics.readingWidth, alignment: .leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 18)
                        .padding(.vertical, 16)
                    }
                    .scrollDismissesKeyboard(.interactively)
                } else {
                    FeatureSourceTextView(lines: sourceLines, wrapsLines: wrapsLines, initialLine: initialLine)
                }
            } else if !isLoading {
                ContentUnavailableView("File unavailable", systemImage: "doc.badge.ellipsis")
            } else {
                Spacer()
            }
        }
        .background(T3Colors.background)
        .navigationTitle(entry.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    if previewKind == .markdown || previewKind == .browser {
                        Picker("View", selection: $mode) {
                            Text("Preview").tag(FeatureFileViewingMode.preview)
                            Text("Source").tag(FeatureFileViewingMode.source)
                        }
                    }
                    if mode == .source {
                        Toggle("Wrap lines", isOn: $wrapsLines)
                    }
                    Button("Copy path", systemImage: "doc.on.doc") {
                        UIPasteboard.general.string = entry.path
                    }
                    if previewKind.hasTextSource {
                        Button("Copy contents", systemImage: "text.document") {
                            Task { await copyContents() }
                        }
                    }
                    if assetURL != nil {
                        Button("Open preview in browser", systemImage: "arrow.up.right.square") {
                            Task {
                                do { openURL(try await resolveAssetURL()) }
                                catch { errorMessage = error.localizedDescription }
                            }
                        }
                    }
                    if supportsPreview {
                        Button("Refresh", systemImage: "arrow.clockwise") {
                            refreshVersion += 1
                        }
                        .disabled(isLoading)
                    }
                } label: {
                    Image(systemName: "ellipsis")
                }
                .accessibilityLabel("File options")
            }
            if let content {
                ToolbarItem(placement: .topBarTrailing) {
                    ShareLink(item: content.text) { Image(systemName: "square.and.arrow.up") }
                        .accessibilityLabel("Share file contents")
                }
            }
        }
        .task(id: loadIdentity) { await load() }
    }

    private var markdownImageContext: MarkdownImageContext? {
        guard let workspaceRoot,
              let resolver = client as? any FeatureWorkspaceAssetResolving else { return nil }
        return MarkdownImageContext(
            threadID: threadID, workspaceRoot: workspaceRoot, resolver: resolver,
            sourceFilePath: entry.path
        )
    }

    private func requireRead() throws {
        try (client.permissions(forThreadID: threadID) ?? EnvironmentPermissionState())
            .require("filesystem:read")
    }

    private func resolveAssetURL() async throws -> URL {
        try requireRead()
        guard let resolver = client as? any FeatureWorkspaceAssetResolving else {
            throw FeatureCapabilityUnavailable("Native file previews")
        }
        return try await resolver.previewAssetURL(
            threadID: threadID, path: entry.path, kind: previewKind
        )
    }

    private func copyContents() async {
        do {
            try requireRead()
            let text: String
            if let content { text = content.text }
            else { text = try await client.readFile(threadID: threadID, path: entry.path).text }
            try Task.checkCancellation()
            UIPasteboard.general.string = text
        } catch {
            guard !Task.isCancelled else { return }
            errorMessage = error.localizedDescription
        }
    }

    private func load() async {
        let identity = loadIdentity
        errorMessage = nil
        guard supportsPreview else {
            content = nil
            sourceLines = []
            assetURL = nil
            isLoading = false
            return
        }
        isLoading = true
        defer {
            if loadIdentity == identity { isLoading = false }
        }
        do {
            try requireRead()
            if mode == .preview, previewKind != .markdown {
                let resolvedURL = try await resolveAssetURL()
                try Task.checkCancellation()
                guard loadIdentity == identity else { return }
                assetURL = resolvedURL
                content = nil
                sourceLines = []
            } else {
                let loaded = try await client.readFile(threadID: threadID, path: entry.path)
                try Task.checkCancellation()
                let lines: [FeatureSourceLine]
                if mode == .source {
                    lines = await Task.detached(priority: .userInitiated) {
                        FeatureSourceHighlighter.lines(text: loaded.text, language: loaded.language ?? "plain")
                    }.value
                } else {
                    lines = []
                }
                if previewKind == .markdown, mode == .preview {
                    _ = await MarkdownRenderCache.shared.document(for: MarkdownContentRevision(loaded.text))
                }
                try Task.checkCancellation()
                guard loadIdentity == identity else { return }
                content = loaded
                sourceLines = lines
                assetURL = nil
            }
        } catch {
            guard !Task.isCancelled, !(error is CancellationError), loadIdentity == identity else { return }
            errorMessage = error.localizedDescription
        }
    }
}

private struct FeatureSourceTextView: View {
    let lines: [FeatureSourceLine]
    let wrapsLines: Bool
    let initialLine: Int?

    private var selectedLine: Int? {
        FeatureFileViewingMode.sourceLine(initialLine, lineCount: lines.count)
    }

    var body: some View {
        GeometryReader { proxy in
            ScrollViewReader { scroll in
                ScrollView(wrapsLines ? .vertical : [.horizontal, .vertical]) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(lines) { line in
                            HStack(alignment: .top, spacing: 10) {
                                Text("\(line.number)")
                                    .foregroundStyle(.tertiary)
                                    .frame(width: 44, alignment: .trailing)
                                    .accessibilityHidden(true)
                                FeatureHighlightedSourceLine(line: line)
                                    .fixedSize(horizontal: !wrapsLines, vertical: true)
                                    .frame(maxWidth: wrapsLines ? .infinity : nil, alignment: .leading)
                            }
                            .font(T3Typography.code)
                            .t3CodeTextSize()
                            .frame(minWidth: max(0, proxy.size.width - 14), minHeight: 22, alignment: .leading)
                            .background(line.number == selectedLine ? Color.accentColor.opacity(0.16) : .clear)
                            .id(line.number)
                        }
                    }
                    .frame(minWidth: max(0, proxy.size.width - 14), alignment: .leading)
                    .padding(.vertical, 10)
                    .padding(.trailing, 14)
                    .frame(minHeight: proxy.size.height, alignment: .topLeading)
                    .textSelection(.enabled)
                }
                .onChange(of: selectedLine, initial: true) { _, line in
                    if let line { scroll.scrollTo(line, anchor: .top) }
                }
            }
        }
        .background(T3Colors.background)
        .accessibilityLabel("Source file")
    }
}

private struct FeatureHighlightedSourceLine: View {
    let line: FeatureSourceLine

    var body: some View {
        renderedText
    }

    private var renderedText: Text {
        guard !line.spans.isEmpty else { return Text(" ") }
        return line.spans.reduce(Text("")) { output, span in
            output + Text(verbatim: span.text).foregroundColor(color(for: span.kind))
        }
    }

    private func color(for kind: FeatureSourceTokenKind) -> Color {
        switch kind {
        case .plain: T3Colors.textPrimary.opacity(0.92)
        case .comment: T3Colors.textTertiary
        case .keyword: T3Colors.syntaxKeyword
        case .literal: T3Colors.syntaxLiteral
        case .number: T3Colors.syntaxNumber
        case .property: T3Colors.syntaxProperty
        }
    }
}
