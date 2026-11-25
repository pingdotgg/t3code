import SwiftUI

struct TurnCheckpointCard: View {
    let fileCount: Int
    let additions: Int64
    let deletions: Int64
    let files: [FfiTurnCheckpointFile]
    let ordinal: Int64?
    let threadId: String
    let store: CoreStore
    @State private var overrides: [String: Bool] = [:]
    @State private var expanded = false
    @State private var selected: ReviewPath?

    private struct ReviewPath: Identifiable { let id: String }

    var body: some View {
        let rows = changedFileRows(files: files, overrides: overrides, expanded: expanded)
        let folders = rows.filter(\.directory)
        let allOpen = folders.allSatisfy(\.expanded)
        ThreadCard {
            Text("\(fileCount) changed \(fileCount == 1 ? "file" : "files")")
            DiffCounts(additions: additions, deletions: deletions)
            Spacer(minLength: 0)
            if !folders.isEmpty {
                Button { expanded = !allOpen; overrides = [:] } label: {
                    Image(systemName: allOpen ? "arrow.up.and.down.text.horizontal" : "arrow.down.left.and.arrow.up.right")
                }.accessibilityLabel(allOpen ? "Collapse all folders" : "Expand all folders")
            }
            if ordinal != nil {
                Button { selected = ReviewPath(id: files.first?.path ?? "") } label: {
                    Image(systemName: "plus.forwardslash.minus").padding(5)
                }.accessibilityLabel("Open diff")
            }
        } content: {
            VStack(spacing: 0) {
                ForEach(rows, id: \.path) { row in
                    Button {
                        if row.directory { overrides[row.path] = !row.expanded }
                        else { selected = ReviewPath(id: row.path) }
                    } label: {
                        HStack(spacing: 6) {
                            if row.directory { Image(systemName: row.expanded ? "chevron.down" : "chevron.right").font(.caption2) }
                            Image(systemName: row.directory ? "folder" : "doc.text")
                            Text(row.name).lineLimit(1).truncationMode(.middle)
                            Spacer()
                            DiffCounts(additions: row.additions, deletions: row.deletions)
                        }
                        .font(.system(size: 13))
                        .padding(.leading, 9 + CGFloat(row.depth) * 12)
                        .padding(.trailing, 9).frame(minHeight: 32).contentShape(Rectangle())
                    }
                    .disabled(!row.directory && ordinal == nil)
                }
            }
        }
        .buttonStyle(.plain)
        .sheet(item: $selected) { path in
            if let ordinal {
                CheckpointReview(files: files, selected: path.id) { try await store.patches(thread: threadId, turn: ordinal) }
            }
        }
    }
}

private struct DiffCounts: View {
    let additions: Int64
    let deletions: Int64
    @Environment(\.connTheme) private var theme
    var body: some View {
        HStack(spacing: 5) {
            Text("+\(additions.formatted(.number.notation(.compactName)))").foregroundStyle(theme.diffAdded)
            Text("−\(deletions.formatted(.number.notation(.compactName)))").foregroundStyle(theme.diffRemoved)
        }
        .font(.caption.monospacedDigit())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(additions) additions, \(deletions) deletions")
    }
}

private struct CheckpointReview: View {
    let files: [FfiTurnCheckpointFile]
    let selected: String
    let load: () async throws -> [FfiFilePatch]
    @State private var patches: [FfiFilePatch]?
    @State private var error: String?
    @State private var attempt = 0
    @State private var collapsed: Set<String> = []
    @State private var viewed: Set<String> = []
    @Environment(\.dismiss) private var dismiss
    @Environment(\.connTheme) private var theme

    var body: some View {
        NavigationStack {
            Group {
                if let patches {
                    if patches.isEmpty { ContentUnavailableView("No line changes", systemImage: "doc.text") }
                    else {
                        ScrollViewReader { proxy in
                            ScrollView {
                                LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                                    ForEach(patches, id: \.path) { patch in
                                        Section {
                                            if !collapsed.contains(patch.path) { PatchBody(patch: patch) }
                                        } header: {
                                            patchHeader(patch).id(patch.path)
                                        }
                                    }
                                }.padding(.bottom, 8)
                            }.onAppear { proxy.scrollTo(selected, anchor: .top) }
                        }
                    }
                } else if let error {
                    VStack { Text(error); Button("Retry") { attempt += 1 } }
                } else { ProgressView("Loading diff…") }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(theme.background)
            .navigationTitle("Changed files").navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Done") { dismiss() } }
            .task(id: attempt) {
                error = nil
                do { let result = try await load(); try Task.checkCancellation(); patches = result }
                catch { if !Task.isCancelled { self.error = error.localizedDescription } }
            }
        }
    }

    private func patchHeader(_ patch: FfiFilePatch) -> some View {
        HStack {
            Button {
                if !collapsed.insert(patch.path).inserted { collapsed.remove(patch.path) }
            } label: {
                HStack(spacing: 6) {
                    ConnIcon(collapsed.contains(patch.path) ? "chevron.right" : "chevron.down")
                    ConnIcon("doc.text").foregroundStyle(theme.mutedForeground)
                    Text(patch.path).lineLimit(1).truncationMode(.middle)
                }
            }
            Spacer()
            if let file = files.first(where: { $0.path == patch.path }) {
                DiffCounts(additions: file.additions, deletions: file.deletions)
            }
            Button {
                if !viewed.insert(patch.path).inserted { viewed.remove(patch.path) }
            } label: { Image(systemName: viewed.contains(patch.path) ? "checkmark.square.fill" : "square") }
                .accessibilityLabel("Mark \(patch.path) as viewed")
                .accessibilityValue(viewed.contains(patch.path) ? "Yes" : "No")
        }.font(.system(size: 13, weight: .medium)).padding(10).buttonStyle(.plain)
        .background(theme.card)
        .overlay(alignment: .bottom) { Divider() }
    }
}

private struct PatchBody: View {
    let patch: FfiFilePatch
    @Environment(\.connTheme) private var theme
    @State private var colors: [AttributedString] = []

    var body: some View {
        if patch.lines.isEmpty {
            Text(patch.binary ? "Binary file" : "No line changes").font(.caption).padding(10)
        } else {
            ScrollView(.horizontal) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(patch.lines.indices, id: \.self) { index in
                        let line = patch.lines[index]
                        let tint = line.marker == "+" ? theme.diffAdded : line.marker == "-" ? theme.diffRemoved : theme.mutedForeground
                        HStack(alignment: .firstTextBaseline, spacing: 5) {
                            Text(line.number.map(String.init) ?? "").frame(width: 36, alignment: .trailing)
                            Text(line.marker == "@@" ? "" : line.marker)
                            if line.number != nil && colors.indices.contains(index) {
                                Text(colors[index])
                            } else {
                                Text(verbatim: line.text)
                                    .foregroundStyle(line.number == nil ? theme.mutedForeground : theme.codeForeground)
                            }
                        }
                        .font(.system(size: 12, design: .monospaced)).foregroundStyle(tint)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(tint.opacity(line.marker == " " ? 0 : 0.12))
                    }
                }
                .padding(.vertical, 8).textSelection(.enabled)
            }
            .task(id: theme.themeId) {
                colors = []
                let themeId = theme.themeId
                let highlighted = await Task.detached(priority: .utility) { [patch] in
                    let bytes = patch.lines.reduce(0) { $0 + $1.text.utf8.count + 1 }
                    guard bytes <= 512 * 1024 else { return [AttributedString]() }
                    // Preserve row indices; hunk headers use their own style.
                    let source = patch.lines.map { $0.number == nil ? "" : $0.text }.joined(separator: "\n")
                    return highlightCode(source: source, language: patch.path, theme: themeId).map(attributedCodeLine)
                }.value
                if !Task.isCancelled { colors = highlighted }
            }
        }
    }
}
