import SwiftUI

@available(iOS 27, *)
struct FeatureThreadToolsToolbar: ToolbarContent {
    let open: (FeatureThreadToolSurface) -> Void

    var body: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            Button("Terminal", systemImage: "terminal") { open(.terminal(nil)) }
            Button("Source control", systemImage: "point.topleft.down.to.point.bottomright.curvepath") {
                open(.sourceControl(.git))
            }
            Button("Files", systemImage: "folder") { open(.files) }
        }
        .visibilityPriority(.low)
    }
}

struct FeatureThreadNavigationChrome: ViewModifier {
    let title: String
    let header: AnyView
    let actions: AnyView
    let showsDirectTools: Bool
    let open: (FeatureThreadToolSurface) -> Void

    func body(content: Content) -> some View {
        content
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .navigationBarBackButtonHidden(false)
            .toolbar(.visible, for: .navigationBar)
            .toolbarRole(.editor)
            .t3NavigationChrome()
            .toolbar {
                ToolbarItem(placement: .principal) { header }
                if #available(iOS 27, *), showsDirectTools {
                    FeatureThreadToolsToolbar(open: open)
                }
                ToolbarItem(placement: .topBarTrailing) { actions }
            }
            .modifier(FeatureThreadToolbarBehavior())
    }
}

struct FeatureWorkspaceTabBarVisibility: ViewModifier {
    @SwiftUI.Environment(\.horizontalSizeClass) private var horizontalSizeClass
    let showsThread: Bool

    func body(content: Content) -> some View {
        if #available(iOS 27.1, *) {
            content.modifier(FeatureThreadDuoTabBarVisibility(isCompact: showsThread && horizontalSizeClass == .compact))
        } else {
            content.toolbar(showsThread && horizontalSizeClass == .compact ? .hidden : .visible, for: .tabBar)
        }
    }
}

@available(iOS 27.1, *)
private struct FeatureThreadDuoTabBarVisibility: ViewModifier {
    @SwiftUI.Environment(\.toolbarVerticalEdge) private var verticalEdge
    let isCompact: Bool

    func body(content: Content) -> some View {
        content.toolbar(isCompact && verticalEdge == nil ? .hidden : .visible, for: .tabBar)
    }
}

private struct FeatureThreadToolbarBehavior: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 27, *) {
            content.toolbarMinimizationBehavior(.never, for: .navigationBar)
        } else {
            content
        }
    }
}
