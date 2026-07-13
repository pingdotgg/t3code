import AppKit
import SwiftUI

/// Full-width main-area diff review. Swaps in for the chat transcript while
/// active; Esc / Done returns to chat. Diff content stays opaque; only the
/// header bar is glass chrome.
public struct DiffReviewView: View {
    private let model: AppModel
    private let threadID: String

    @AppStorage(DiffZoom.appStorageKey) private var zoomFactor = DiffZoom.defaultFactor
    @UIState private var viewMode: DiffViewMode = .unified
    @UIState private var showFilePopover = false
    @UIState private var unifiedRows: [UnifiedDiffRow] = []
    @UIState private var sideBySideRows: [SideBySideDiffRow] = []
    @UIState private var preparedUnifiedKey: DiffSelectionKey?
    @UIState private var preparedSideBySideKey: DiffSelectionKey?
    @UIState private var rowPreparationTask: Task<Void, Never>?
    @UIState private var inFlightRequest: DiffPreparationRequest?
    @UIState private var preparationGeneration = 0
    @UIState private var isPreparing = false
    @UIState private var contentWidth: CGFloat = 0
    @UIState private var magnifyBaseZoom: Double?

    public init(model: AppModel, threadID: String) {
        self.model = model
        self.threadID = threadID
    }

    private enum DiffViewMode: String, CaseIterable, Sendable {
        case unified
        case sideBySide

        var label: String {
            switch self {
            case .unified: "Unified"
            case .sideBySide: "Side by Side"
            }
        }
    }

    private struct DiffSelectionKey: Equatable, Hashable, Sendable {
        let path: String?
        let contentHash: Int?
    }

    private struct DiffPreparationRequest: Equatable, Hashable, Sendable {
        let selection: DiffSelectionKey
        let mode: DiffViewMode
    }

    private var threadState: ThreadState? {
        model.threadState(threadID)
    }

    private var files: [DiffFile] {
        threadState?.reviewDiff ?? []
    }

    private var scopeTitle: String {
        threadState?.reviewScope?.title ?? "Changes"
    }

    private var selectedPath: String? {
        threadState?.reviewSelectedPath
    }

    private var selectedFile: DiffFile? {
        if let selectedPath, let match = files.first(where: { $0.path == selectedPath }) {
            return match
        }
        return files.first
    }

    private var selectedFileKey: DiffSelectionKey {
        guard let file = selectedFile else {
            return DiffSelectionKey(path: nil, contentHash: nil)
        }
        return DiffSelectionKey(path: file.path, contentHash: contentHash(for: file))
    }

    private var selectedIndex: Int? {
        guard let path = selectedPath else { return files.isEmpty ? nil : 0 }
        return files.firstIndex(where: { $0.path == path })
    }

    private var effectiveZoom: Double {
        DiffZoom.clamp(zoomFactor)
    }

    private var renderedMode: DiffViewMode {
        viewMode == .sideBySide && contentWidth >= 700 ? .sideBySide : .unified
    }

    public var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
        }
        .background(.background)
        .onAppear(perform: normalizeZoom)
        .onChange(of: selectedFileKey) { _, newKey in
            prepareRows(for: newKey, mode: renderedMode)
        }
        .onChange(of: files.map(\.path)) { _, _ in
            prepareRows(for: selectedFileKey, mode: renderedMode)
        }
        .onChange(of: renderedMode) { _, newMode in
            prepareRows(for: selectedFileKey, mode: newMode)
        }
        .task(id: selectedFileKey) {
            prepareRows(for: selectedFileKey, mode: renderedMode)
        }
        .onDisappear {
            rowPreparationTask?.cancel()
            rowPreparationTask = nil
        }
        .focusable()
        .onKeyPress(.escape) {
            withAnimation(Motion.settle) {
                model.closeReview(threadID: threadID)
            }
            return .handled
        }
        .gesture(
            MagnifyGesture()
                .onChanged { value in
                    // `magnification` is total since gesture start, so scale a
                    // fixed anchor — multiplying the live factor each event
                    // compounds exponentially.
                    let base = magnifyBaseZoom ?? effectiveZoom
                    magnifyBaseZoom = base
                    setZoom(base * max(0.1, value.magnification))
                }
                .onEnded { _ in
                    magnifyBaseZoom = nil
                }
        )
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 10) {
            Button {
                withAnimation(Motion.settle) {
                    model.closeReview(threadID: threadID)
                }
            } label: {
                Label("Done", systemImage: "xmark")
            }
            .keyboardShortcut(.escape, modifiers: [])
            .help("Return to chat (Esc)")

            Text(scopeTitle)
                .font(.headline)
                .lineLimit(1)
                .truncationMode(.middle)

            Spacer(minLength: 8)

            if !files.isEmpty {
                fileNavigation
                viewModeToggle
            }

            // Hidden zoom shortcuts (no visible buttons).
            zoomShortcuts
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .glassEffect(.regular, in: .rect(cornerRadius: 12))
        .padding(8)
    }

    private var fileNavigation: some View {
        HStack(spacing: 4) {
            Button {
                stepFile(by: -1)
            } label: {
                Image(systemName: "chevron.up")
            }
            .keyboardShortcut(.upArrow, modifiers: [.command, .option])
            .disabled(selectedIndex.map { $0 <= 0 } ?? true)
            .help("Previous file (⌘⌥↑)")

            Button {
                stepFile(by: 1)
            } label: {
                Image(systemName: "chevron.down")
            }
            .keyboardShortcut(.downArrow, modifiers: [.command, .option])
            .disabled(
                selectedIndex.map { $0 >= files.count - 1 } ?? true
            )
            .help("Next file (⌘⌥↓)")

            Button {
                showFilePopover.toggle()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: statusGlyph(selectedFile?.status ?? .modified))
                        .font(.caption2)
                        .foregroundStyle(statusColor(selectedFile?.status ?? .modified))
                        .frame(width: 12)
                    Text(selectedFile.map { ($0.path as NSString).lastPathComponent } ?? "—")
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if files.count > 1 {
                        Text("\( (selectedIndex ?? 0) + 1 )/\(files.count)")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Image(systemName: "chevron.down")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: 220)
            }
            .popover(isPresented: $showFilePopover, arrowEdge: .bottom) {
                filePopoverList
                    .frame(minWidth: 320, maxHeight: 360)
            }
            .help("Choose file")
        }
        .controlSize(.small)
    }

    private var filePopoverList: some View {
        List {
            ForEach(files) { file in
                Button {
                    model.selectReviewFile(threadID: threadID, path: file.path)
                    showFilePopover = false
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: statusGlyph(file.status))
                            .font(.caption2)
                            .foregroundStyle(statusColor(file.status))
                            .frame(width: 12)
                        Text(file.path)
                            .font(.system(.body, design: .monospaced))
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer(minLength: 4)
                        let add = DiffPresentation.additionCount(in: file)
                        let del = DiffPresentation.deletionCount(in: file)
                        if add > 0 {
                            Text("+\(add)")
                                .foregroundStyle(.green)
                                .font(.caption.monospacedDigit())
                        }
                        if del > 0 {
                            Text("−\(del)")
                                .foregroundStyle(.red)
                                .font(.caption.monospacedDigit())
                        }
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .listStyle(.sidebar)
    }

    private var viewModeToggle: some View {
        Picker("View", selection: $viewMode) {
            Text("Unified").tag(DiffViewMode.unified)
            Text("Side by Side").tag(DiffViewMode.sideBySide)
        }
        .pickerStyle(.segmented)
        .frame(width: 200)
        .help("Toggle unified and side-by-side")
    }

    private var zoomShortcuts: some View {
        // Shortcut-only holders: a default-styled button still paints its
        // bezel even at zero frame, so keep these plain and fully invisible.
        HStack(spacing: 0) {
            Button(action: zoomIn) { EmptyView() }
                .keyboardShortcut("=", modifiers: .command)
            Button(action: zoomIn) { EmptyView() }
                .keyboardShortcut("+", modifiers: .command)
            Button(action: zoomOut) { EmptyView() }
                .keyboardShortcut("-", modifiers: .command)
            Button(action: resetZoom) { EmptyView() }
                .keyboardShortcut("0", modifiers: .command)
            Button(action: zoomIn) { EmptyView() }
                .keyboardShortcut("=", modifiers: [.command, .shift])
        }
        .buttonStyle(.plain)
        .frame(width: 0, height: 0)
        .clipped()
        .opacity(0)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        if threadState?.isLoadingReviewDiff == true && files.isEmpty {
            ProgressView("Loading diff…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if files.isEmpty {
            ContentUnavailableView(
                "No Changes",
                systemImage: "doc.text.magnifyingglass",
                description: Text("This scope has no pending diff.")
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let selectedFile, selectedFile.hunks.isEmpty {
            emptyFileState(for: selectedFile)
        } else {
            GeometryReader { geo in
                let effectiveMode = renderedMode
                Group {
                    if isPreparing && !hasPreparedRows(for: selectedFileKey, mode: effectiveMode) {
                        ProgressView()
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else {
                        VStack(spacing: 0) {
                            if viewMode == .sideBySide && geo.size.width < 700 {
                                Text("Side-by-side needs a wider window — showing unified.")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 4)
                                    .background(Color.secondary.opacity(0.08))
                            }
                            if effectiveMode == .sideBySide {
                                sideBySideScroll
                            } else {
                                unifiedScroll
                            }
                        }
                    }
                }
                .onAppear { contentWidth = geo.size.width }
                .onChange(of: geo.size.width) { _, width in contentWidth = width }
            }
        }
    }

    private var unifiedScroll: some View {
        let zoom = effectiveZoom
        let gutter = DiffZoom.gutterWidth(for: zoom)
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(unifiedRows) { row in
                    if row.kind == .hunkHeader {
                        hunkHeader(row.header, zoom: zoom)
                    } else {
                        UnifiedLineView(row: row, zoomFactor: zoom, gutterWidth: gutter)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)
        }
        .background(.background)
        .id(selectedFileKey)
        .transition(Motion.paneSwap)
    }

    private var sideBySideScroll: some View {
        let zoom = effectiveZoom
        let gutter = DiffZoom.gutterWidth(for: zoom)
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(sideBySideRows) { row in
                    if row.kind == .hunkHeader {
                        hunkHeader(row.header, zoom: zoom)
                    } else {
                        SideBySideLineView(row: row, zoomFactor: zoom, gutterWidth: gutter)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)
        }
        .background(.background)
        .id("sbs-\(selectedFileKey.path ?? "")-\(selectedFileKey.contentHash ?? 0)")
        .transition(Motion.paneSwap)
    }

    private func hunkHeader(_ header: String, zoom: Double) -> some View {
        Text(header)
            .font(.system(size: DiffZoom.captionFontSize(for: zoom), design: .monospaced))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.middle)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.secondary.opacity(0.12))
    }

    // MARK: - Row preparation

    private func prepareRows(for key: DiffSelectionKey, mode: DiffViewMode) {
        guard let path = key.path, let file = files.first(where: { $0.path == path }) else {
            rowPreparationTask?.cancel()
            rowPreparationTask = nil
            inFlightRequest = nil
            unifiedRows = []
            sideBySideRows = []
            preparedUnifiedKey = nil
            preparedSideBySideKey = nil
            isPreparing = false
            return
        }

        let request = DiffPreparationRequest(selection: key, mode: mode)
        guard !hasPreparedRows(for: key, mode: mode) else {
            if inFlightRequest == nil || inFlightRequest == request {
                isPreparing = false
            }
            return
        }
        guard inFlightRequest != request else { return }

        rowPreparationTask?.cancel()
        preparationGeneration += 1
        let generation = preparationGeneration
        inFlightRequest = request
        isPreparing = true
        if mode == .unified {
            unifiedRows = []
        } else {
            sideBySideRows = []
        }

        let captured = file
        rowPreparationTask = Task.detached(priority: .userInitiated) {
            do {
                switch mode {
                case .unified:
                    let rows = try DiffPresentation.buildUnifiedRows(for: captured)
                    try Task.checkCancellation()
                    await MainActor.run {
                        guard generation == preparationGeneration,
                              selectedFileKey == key,
                              renderedMode == mode else { return }
                        unifiedRows = rows
                        preparedUnifiedKey = key
                        inFlightRequest = nil
                        isPreparing = false
                        rowPreparationTask = nil
                    }
                case .sideBySide:
                    let rows = try DiffPresentation.buildSideBySideRows(for: captured)
                    try Task.checkCancellation()
                    await MainActor.run {
                        guard generation == preparationGeneration,
                              selectedFileKey == key,
                              renderedMode == mode else { return }
                        sideBySideRows = rows
                        preparedSideBySideKey = key
                        inFlightRequest = nil
                        isPreparing = false
                        rowPreparationTask = nil
                    }
                }
            } catch is CancellationError {
                // A newer selection or mode owns the loading state.
            } catch {
                // Keep the empty/previous view state if row preparation fails.
                await MainActor.run {
                    guard generation == preparationGeneration else { return }
                    inFlightRequest = nil
                    isPreparing = false
                    rowPreparationTask = nil
                }
            }
        }
    }

    private func hasPreparedRows(for key: DiffSelectionKey, mode: DiffViewMode) -> Bool {
        switch mode {
        case .unified:
            preparedUnifiedKey == key
        case .sideBySide:
            preparedSideBySideKey == key
        }
    }

    private func contentHash(for file: DiffFile) -> Int {
        var hasher = Hasher()
        hasher.combine(file.path)
        hasher.combine(file.status.rawValue)
        hasher.combine(file.hunks.count)
        for hunk in file.hunks {
            hasher.combine(hunk.header)
            hasher.combine(hunk.lines.count)
            for line in hunk.lines {
                switch line.kind {
                case .context: hasher.combine(0)
                case .addition: hasher.combine(1)
                case .deletion: hasher.combine(2)
                }
                hasher.combine(line.text)
                hasher.combine(line.oldNumber)
                hasher.combine(line.newNumber)
            }
        }
        return hasher.finalize()
    }

    // MARK: - Navigation / zoom

    private func stepFile(by delta: Int) {
        guard let idx = selectedIndex else { return }
        let next = idx + delta
        guard files.indices.contains(next) else { return }
        model.selectReviewFile(threadID: threadID, path: files[next].path)
    }

    private func zoomIn() {
        setZoom(DiffZoom.stepped(effectiveZoom, by: DiffZoom.step))
    }

    private func zoomOut() {
        setZoom(DiffZoom.stepped(effectiveZoom, by: -DiffZoom.step))
    }

    private func resetZoom() {
        setZoom(DiffZoom.defaultFactor)
    }

    private func setZoom(_ factor: Double) {
        zoomFactor = DiffZoom.clamp(factor)
    }

    private func normalizeZoom() {
        setZoom(effectiveZoom)
    }

    private func statusColor(_ status: DiffFileStatus) -> Color {
        switch status {
        case .added: .green
        case .modified: .orange
        case .deleted: .red
        case .renamed: .blue
        }
    }

    private func statusGlyph(_ status: DiffFileStatus) -> String {
        switch status {
        case .added: "plus.circle"
        case .modified: "pencil.circle"
        case .deleted: "minus.circle"
        case .renamed: "arrow.right.circle"
        }
    }

    private func emptyFileState(for file: DiffFile) -> some View {
        let description: String
        switch file.status {
        case .renamed:
            description = "File was renamed (no content changes)"
        case .added, .modified, .deleted:
            description = "No displayable changes — the file may be binary."
        }
        return ContentUnavailableView(
            file.status == .renamed ? "Renamed File" : "No Displayable Changes",
            systemImage: statusGlyph(file.status),
            description: Text(description)
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Unified line

private struct UnifiedLineView: View {
    let row: UnifiedDiffRow
    let zoomFactor: Double
    let gutterWidth: CGFloat

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            gutter(row.oldNumber)
            gutter(row.newNumber)
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                Text(marker)
                    .font(contentFont)
                    .foregroundStyle(.secondary)
                highlightedText
                    .font(contentFont)
                    // Soft wrap at word boundaries; hanging indent past gutter
                    // is achieved by the HStack padding layout.
                    .lineLimit(nil)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.leading, DiffZoom.codeLeadingPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(baseBackground)
    }

    private var marker: String {
        switch row.lineKind {
        case .addition: "+ "
        case .deletion: "- "
        case .context: "  "
        }
    }

    private var contentFont: Font {
        .system(size: DiffZoom.contentFontSize(for: zoomFactor), design: .monospaced)
    }

    private var baseBackground: Color {
        switch row.lineKind {
        case .addition: Color.green.opacity(0.10)
        case .deletion: Color.red.opacity(0.10)
        case .context: Color.clear
        }
    }

    private var highlightedText: some View {
        Text(row.attributed)
    }

    private func gutter(_ number: Int?) -> some View {
        Text(number.map(String.init) ?? "")
            .font(.system(size: DiffZoom.captionFontSize(for: zoomFactor), design: .monospaced))
            .foregroundStyle(.secondary)
            .frame(width: gutterWidth, alignment: .trailing)
    }
}

// MARK: - Side-by-side line

private struct SideBySideLineView: View {
    let row: SideBySideDiffRow
    let zoomFactor: Double
    let gutterWidth: CGFloat

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            side(
                number: row.oldNumber,
                kind: row.oldLineKind,
                attributed: row.oldAttributed
            )
            Rectangle()
                .fill(Color.secondary.opacity(0.2))
                .frame(width: 1)
            side(
                number: row.newNumber,
                kind: row.newLineKind,
                attributed: row.newAttributed
            )
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func side(
        number: Int?,
        kind: DiffLineKind?,
        attributed: AttributedString?
    ) -> some View {
        HStack(alignment: .top, spacing: 0) {
            Text(number.map(String.init) ?? "")
                .font(.system(size: DiffZoom.captionFontSize(for: zoomFactor), design: .monospaced))
                .foregroundStyle(.secondary)
                .frame(width: gutterWidth, alignment: .trailing)
            Group {
                if let attributed {
                    Text(attributed)
                        .font(
                            .system(
                                size: DiffZoom.contentFontSize(for: zoomFactor), design: .monospaced)
                        )
                    .lineLimit(nil)
                    .fixedSize(horizontal: false, vertical: true)
                } else {
                    Text(" ")
                        .font(
                            .system(
                                size: DiffZoom.contentFontSize(for: zoomFactor), design: .monospaced)
                        )
                }
            }
            .padding(.leading, DiffZoom.codeLeadingPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(sideBackground(kind))
    }

    private func sideBackground(_ kind: DiffLineKind?) -> Color {
        switch kind {
        case .addition: Color.green.opacity(0.10)
        case .deletion: Color.red.opacity(0.10)
        case .context, .none: Color.clear
        }
    }
}
