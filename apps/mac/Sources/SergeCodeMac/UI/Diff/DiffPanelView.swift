import SwiftUI

// Diff panel: file list + unified diff for the selected file. Content layers
// (the diff text itself) stay opaque per the Liquid Glass rules — only the
// header bar is glass chrome.

public struct DiffPanelView: View {
    private let model: AppModel
    private let threadID: String

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

    public var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if files.isEmpty {
                emptyState
                    .transition(Motion.paneSwap)
            } else {
                HSplitView {
                    fileList
                        .frame(minWidth: 220, idealWidth: 260, maxWidth: 340, maxHeight: .infinity)
                    diffDetail
                        .frame(minWidth: 360, maxWidth: .infinity, maxHeight: .infinity)
                }
                .transition(Motion.paneSwap)
            }
        }
        .animation(Motion.settle, value: files.isEmpty)
        .animation(Motion.settle, value: selectedFile?.path)
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
            GeometryReader { proxy in
                ScrollView(.vertical) {
                    ScrollView(.horizontal) {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(file.hunks) { hunk in
                                hunkHeaderView(hunk.header)
                                ForEach(hunk.lines) { line in
                                    DiffLineRowView(line: line)
                                }
                            }
                        }
                        .frame(minWidth: proxy.size.width, alignment: .leading)
                    }
                }
                .background(.background)
            }
            // Identity per file so picking another file cross-fades the
            // detail pane.
            .id(file.path)
            .transition(Motion.paneSwap)
        } else {
            emptyState
        }
    }

    private func hunkHeaderView(_ header: String) -> some View {
        Text(header)
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.secondary.opacity(0.12))
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

    var body: some View {
        HStack(spacing: 0) {
            gutter(line.oldNumber)
            gutter(line.newNumber)
            Text(marker + " " + line.text)
                .font(.system(.body, design: .monospaced))
                .fixedSize(horizontal: true, vertical: false)
                .padding(.leading, 6)
            Spacer(minLength: 12)
        }
        .padding(.vertical, 1)
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
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(.secondary)
            .frame(width: 40, alignment: .trailing)
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
