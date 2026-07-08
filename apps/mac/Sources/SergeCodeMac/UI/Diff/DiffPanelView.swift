import AppKit
import SwiftUI

// Diff panel: file list + unified diff for the selected file. Content layers
// (the diff text itself) stay opaque per the Liquid Glass rules — only the
// header bar is glass chrome.

private enum DiffZoom {
    static let minFactor = 0.6
    static let maxFactor = 2.0
    static let defaultFactor = 1.0
    static let step = 0.1

    private static let contentBaseSize: CGFloat = 13
    private static let captionBaseSize: CGFloat = 10
    private static let gutterBaseWidth: CGFloat = 40

    static func clamp(_ factor: Double) -> Double {
        let rounded = (factor * 100).rounded() / 100
        return min(maxFactor, max(minFactor, rounded))
    }

    static func stepped(_ factor: Double, by delta: Double) -> Double {
        let next = ((factor + delta) / step).rounded() * step
        return clamp(next)
    }

    static func contentFont(for factor: Double) -> Font {
        .system(size: contentBaseSize * CGFloat(clamp(factor)), design: .monospaced)
    }

    static func captionFont(for factor: Double) -> Font {
        .system(size: captionBaseSize * CGFloat(clamp(factor)), design: .monospaced)
    }

    static func gutterWidth(for factor: Double) -> CGFloat {
        gutterBaseWidth * CGFloat(clamp(factor))
    }
}

public struct DiffPanelView: View {
    private let model: AppModel
    private let threadID: String

    @AppStorage("diffPanelZoomFactor") private var zoomFactor = DiffZoom.defaultFactor
    @UIState private var selectedPath: String?

    public init(model: AppModel, threadID: String) {
        self.model = model
        self.threadID = threadID
    }

    private var files: [DiffFile] {
        model.diffs[threadID] ?? []
    }

    private var selectedFile: DiffFile? {
        if let selectedPath, let match = files.first(where: { $0.path == selectedPath }) {
            return match
        }
        return files.first
    }

    private var effectiveZoomFactor: Double {
        DiffZoom.clamp(zoomFactor)
    }

    private var zoomPercentText: String {
        "\(Int((effectiveZoomFactor * 100).rounded()))%"
    }

    public var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if files.isEmpty {
                emptyState
                    .transition(Motion.paneSwap)
            } else {
                // Vertical split: the inspector column is 300–480pt wide, so
                // a side-by-side HSplitView (220pt list + 360pt detail
                // minimums) could never fit and clipped/overflowed instead.
                VSplitView {
                    fileList
                        .frame(minHeight: 96, idealHeight: 160, maxHeight: 320)
                    diffDetail
                        .frame(maxWidth: .infinity, minHeight: 160, maxHeight: .infinity)
                }
                .transition(Motion.paneSwap)
            }
        }
        .animation(Motion.settle, value: files.isEmpty)
        .animation(Motion.settle, value: selectedFile?.path)
        .onAppear(perform: normalizeZoomFactor)
        .task(id: threadID) {
            await model.refreshDiff(threadID: threadID)
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack {
            Label("Changes", systemImage: "arrow.left.arrow.right")
                .font(.headline)
            if !files.isEmpty {
                Text("\(files.count) file\(files.count == 1 ? "" : "s")")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .contentTransition(.numericText())
                    .transition(.opacity)
            }
            Spacer()
            if !files.isEmpty {
                zoomControls
            }
            Button {
                Task { await model.refreshDiff(threadID: threadID) }
            } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
                    .labelStyle(.iconOnly)
            }
            .buttonStyle(.glass)
            .help("Refresh diff")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .glassEffect(.regular, in: .rect(cornerRadius: 12))
        .padding(8)
    }

    private var zoomControls: some View {
        HStack(spacing: 4) {
            Button(action: zoomOut) {
                Label("Zoom out", systemImage: "minus")
                    .labelStyle(.iconOnly)
            }
            .keyboardShortcut("-", modifiers: .command)
            .disabled(effectiveZoomFactor <= DiffZoom.minFactor)
            .help("Zoom out")

            Button(action: resetZoom) {
                Text(zoomPercentText)
                    .font(.caption.monospacedDigit())
                    .frame(minWidth: 38)
            }
            .keyboardShortcut("0", modifiers: .command)
            .help("Reset diff zoom")

            Button(action: zoomIn) {
                Label("Zoom in", systemImage: "plus")
                    .labelStyle(.iconOnly)
            }
            .keyboardShortcut("=", modifiers: .command)
            .disabled(effectiveZoomFactor >= DiffZoom.maxFactor)
            .help("Zoom in")

            Button(action: zoomIn) {
                EmptyView()
            }
            .keyboardShortcut("+", modifiers: .command)
            .frame(width: 0, height: 0)
            .accessibilityHidden(true)

            Button(action: zoomIn) {
                EmptyView()
            }
            .keyboardShortcut("=", modifiers: [.command, .shift])
            .frame(width: 0, height: 0)
            .accessibilityHidden(true)
        }
        .font(.caption)
        .buttonStyle(.glass)
        .controlSize(.small)
    }

    // MARK: - File list

    private var fileList: some View {
        let selectionBinding = Binding<String?>(
            get: { selectedFile?.path },
            set: { selectedPath = $0 }
        )
        return List(selection: selectionBinding) {
            ForEach(files) { file in
                fileRow(file)
                    .tag(file.path)
            }
        }
        .listStyle(.sidebar)
        .scrollContentBackground(.hidden)
    }

    private func fileRow(_ file: DiffFile) -> some View {
        HStack(spacing: 8) {
            Circle()
                .fill(statusColor(file.status))
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 1) {
                Text(file.path)
                    .font(.system(.body, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(statusLabel(file.status))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 4)
            HStack(spacing: 6) {
                let additions = file.additionCount
                let deletions = file.deletionCount
                if additions > 0 {
                    Text("+\(additions)")
                        .foregroundStyle(.green)
                }
                if deletions > 0 {
                    Text("-\(deletions)")
                        .foregroundStyle(.red)
                }
            }
            .font(.caption.monospacedDigit())
        }
        .padding(.vertical, 2)
    }

    private func statusColor(_ status: DiffFileStatus) -> Color {
        switch status {
        case .added: .green
        case .modified: .orange
        case .deleted: .red
        case .renamed: .blue
        }
    }

    private func statusLabel(_ status: DiffFileStatus) -> String {
        switch status {
        case .added: "Added"
        case .modified: "Modified"
        case .deleted: "Deleted"
        case .renamed: "Renamed"
        }
    }

    // MARK: - Diff detail

    @ViewBuilder
    private var diffDetail: some View {
        if let file = selectedFile {
            let zoom = effectiveZoomFactor
            let gutterWidth = DiffZoom.gutterWidth(for: zoom)
            // NSScrollView, not SwiftUI's two-axis ScrollView: the SwiftUI
            // one doesn't reliably engage horizontal panning on macOS (and a
            // scroll wheel can never reach it), so long lines were
            // unreachable. AppKit gives native both-axis trackpad panning
            // plus a real horizontal scroller.
            PanScrollView(onMagnify: applyMagnification) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(file.hunks) { hunk in
                        hunkHeaderView(hunk.header, zoomFactor: zoom)
                        ForEach(hunk.lines) { line in
                            DiffLineRowView(
                                line: line,
                                zoomFactor: zoom,
                                gutterWidth: gutterWidth
                            )
                        }
                    }
                }
            }
            .background(.background)
            // Identity per file so picking another file cross-fades the
            // detail pane.
            .id(file.path)
            .transition(Motion.paneSwap)
        } else {
            emptyState
        }
    }

    private func hunkHeaderView(_ header: String, zoomFactor: Double) -> some View {
        Text(header)
            .font(DiffZoom.captionFont(for: zoomFactor))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.secondary.opacity(0.12))
    }

    private func zoomIn() {
        setZoomFactor(DiffZoom.stepped(effectiveZoomFactor, by: DiffZoom.step))
    }

    private func zoomOut() {
        setZoomFactor(DiffZoom.stepped(effectiveZoomFactor, by: -DiffZoom.step))
    }

    private func resetZoom() {
        setZoomFactor(DiffZoom.defaultFactor)
    }

    private func applyMagnification(_ magnification: CGFloat) {
        let scale = max(0.1, 1 + Double(magnification))
        setZoomFactor(effectiveZoomFactor * scale)
    }

    private func normalizeZoomFactor() {
        setZoomFactor(effectiveZoomFactor)
    }

    private func setZoomFactor(_ factor: Double) {
        zoomFactor = DiffZoom.clamp(factor)
    }

    // MARK: - Empty state

    private var emptyState: some View {
        ContentUnavailableView(
            "No Changes",
            systemImage: "doc.text.magnifyingglass",
            description: Text("This thread has no pending diff.")
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Diff line row

private struct DiffLineRowView: View {
    let line: DiffLine
    let zoomFactor: Double
    let gutterWidth: CGFloat

    var body: some View {
        HStack(spacing: 0) {
            gutter(line.oldNumber)
            gutter(line.newNumber)
            Text(marker + " " + line.text)
                .font(DiffZoom.contentFont(for: zoomFactor))
                .fixedSize(horizontal: true, vertical: false)
                .padding(.leading, 6)
            Spacer(minLength: 12)
        }
        .padding(.vertical, 1)
        // Stretch to the widest row so add/remove stripes span the full
        // scrollable width instead of stopping at each line's own text.
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(backgroundColor)
    }

    private var marker: String {
        switch line.kind {
        case .addition: "+"
        case .deletion: "-"
        case .context: " "
        }
    }

    private var backgroundColor: Color {
        switch line.kind {
        case .addition: Color.green.opacity(0.12)
        case .deletion: Color.red.opacity(0.12)
        case .context: Color.clear
        }
    }

    private func gutter(_ number: Int?) -> some View {
        Text(number.map(String.init) ?? "")
            .font(DiffZoom.captionFont(for: zoomFactor))
            .foregroundStyle(.secondary)
            .frame(width: gutterWidth, alignment: .trailing)
    }
}

private extension DiffFile {
    var additionCount: Int {
        hunks.reduce(0) { count, hunk in
            count + hunk.lines.filter {
                if case .addition = $0.kind { return true }
                return false
            }.count
        }
    }

    var deletionCount: Int {
        hunks.reduce(0) { count, hunk in
            count + hunk.lines.filter {
                if case .deletion = $0.kind { return true }
                return false
            }.count
        }
    }
}
