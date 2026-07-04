import SwiftUI

/// Workspace file browser for the inspector's Files tab: breadcrumb
/// navigation over projects.listEntries, inline file preview via
/// projects.readFile, and an open-in-editor menu.
struct FileBrowserView: View {
    let model: AppModel
    let threadID: String

    @UIState private var subpath = ""
    @UIState private var entries: [WorkspaceEntry] = []
    @UIState private var isLoading = false
    @UIState private var preview: FilePreview?

    var body: some View {
        VStack(spacing: 0) {
            breadcrumbBar
            Divider()
            if let preview {
                FilePreviewPane(preview: preview, model: model) {
                    self.preview = nil
                }
            } else {
                entryList
            }
        }
        .task(id: threadID) {
            subpath = ""
            preview = nil
            await reload()
        }
    }

    private var breadcrumbBar: some View {
        HStack(spacing: 6) {
            Button {
                preview = nil
                subpath = ""
                Task { await reload() }
            } label: {
                Image(systemName: "house")
                    .font(.caption)
            }
            .buttonStyle(.plain)

            if !currentPath.isEmpty {
                Text(currentPath)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.head)
            }

            Spacer()

            if !subpath.isEmpty || preview != nil {
                Button {
                    goUp()
                } label: {
                    Label("Up", systemImage: "chevron.up")
                        .font(.caption)
                }
                .buttonStyle(.plain)
            }

            Menu {
                ForEach(ExternalEditor.allCases) { editor in
                    Button("Open in \(editor.displayName)") {
                        Task {
                            await model.openInEditor(
                                subpath: preview?.path ?? (subpath.isEmpty ? nil : subpath),
                                editor: editor)
                        }
                    }
                }
            } label: {
                Image(systemName: "arrow.up.forward.app")
                    .font(.caption)
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .help("Open in external editor")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private var currentPath: String {
        preview?.path ?? subpath
    }

    @ViewBuilder
    private var entryList: some View {
        if isLoading && entries.isEmpty {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if entries.isEmpty {
            ContentUnavailableView(
                "Empty directory", systemImage: "folder",
                description: Text("No entries here."))
        } else {
            List(entries) { entry in
                Button {
                    open(entry)
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: entry.isDirectory ? "folder.fill" : "doc.text")
                            .foregroundStyle(entry.isDirectory ? Color.accentColor : .secondary)
                            .frame(width: 16)
                        Text(displayName(entry))
                            .font(.callout)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        if entry.isDirectory {
                            Image(systemName: "chevron.right")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .listStyle(.inset)
        }
    }

    /// Entries come back project-relative; show just the last component.
    private func displayName(_ entry: WorkspaceEntry) -> String {
        (entry.path as NSString).lastPathComponent
    }

    private func open(_ entry: WorkspaceEntry) {
        if entry.isDirectory {
            subpath = entry.path
            Task { await reload() }
        } else {
            Task { preview = await model.readWorkspaceFile(path: entry.path) }
        }
    }

    private func goUp() {
        if preview != nil {
            preview = nil
            return
        }
        let parent = (subpath as NSString).deletingLastPathComponent
        subpath = parent
        Task { await reload() }
    }

    private func reload() async {
        isLoading = true
        entries = await model.listWorkspace(subpath: subpath)
        isLoading = false
    }
}

/// Read-only monospaced file preview (opaque background — reading surface).
private struct FilePreviewPane: View {
    let preview: FilePreview
    let model: AppModel
    let onClose: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            if preview.truncated {
                Text("File truncated — open in an editor for the full contents.")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 4)
            }
            ScrollView([.vertical, .horizontal]) {
                Text(preview.contents)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
            }
            .background(Color(nsColor: .textBackgroundColor))
        }
    }
}
