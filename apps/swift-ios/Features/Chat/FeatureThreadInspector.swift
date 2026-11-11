import SwiftUI

/// The workspace places this stack outside the thread's navigation container,
/// so its title, search, and folder navigation keep their own bar.
struct FeatureThreadInspector: View {
    let client: any FeatureClient
    let thread: FeatureThread
    let surface: FeatureThreadToolSurface
    let workspaceRoot: String?
    let permissions: EnvironmentPermissionState?
    let browser: FeatureFileBrowserState
    @Binding var path: NavigationPath
    let close: () -> Void
    let openFile: (String) -> Void
    let beforeRootAction: ((@escaping @MainActor () -> Void) -> Void)?

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                switch surface {
                case .files:
                    FeatureFilesView(client: client, threadID: thread.id, workspaceRoot: workspaceRoot,
                                     permissions: permissions, onClose: close, browser: browser)
                case let .file(file, line):
                    FeatureFilesView(client: client, threadID: thread.id, initialPath: file,
                                     initialLine: line, workspaceRoot: workspaceRoot,
                                     permissions: permissions, onClose: close, browser: browser)
                case let .sourceControl(destination):
                    FeatureSourceControlView(client: client, threadID: thread.id,
                                             initialDestination: destination, onClose: close)
                default:
                    EmptyView()
                }
            }
        }
        .featureKeyboardScope(
            id: "workspace-tool:\(thread.id)", enabledCommands: [.back],
            beforeRootAction: beforeRootAction,
            onCommand: { _ in
                if path.isEmpty { close() } else { path.removeLast() }
            }
        )
        .modifier(FeatureWorkspaceToolOpenURL(workspaceRoot: workspaceRoot, openFile: openFile))
    }
}

private struct FeatureWorkspaceToolOpenURL: ViewModifier {
    @SwiftUI.Environment(\.openURL) private var parent
    let workspaceRoot: String?
    let openFile: (String) -> Void

    func body(content: Content) -> some View {
        content.environment(\.openURL, OpenURLAction { url in
            if let workspaceRoot,
               let path = MarkdownWorkspaceFileLink.relativePath(for: url, workspaceRoot: workspaceRoot) {
                openFile(path)
            } else {
                parent(url)
            }
            return .handled
        })
    }
}

struct FeatureToolCloseToolbar: ToolbarContent {
    let close: (() -> Void)?

    var body: some ToolbarContent {
        if let close {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Close", systemImage: "xmark", action: close).labelStyle(.iconOnly)
            }
        }
    }
}
