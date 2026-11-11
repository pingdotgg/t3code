import SwiftUI
import UIKit

extension EnvironmentValues {
    @Entry var featureWorkspaceFoldSidebarWidth: CGFloat? = nil
}

@MainActor
enum PlatformWorkspaceOrientation {
    private static let hingeWindows = NSHashTable<UIWindow>.weakObjects()

    static func allowHingeOrientations(in window: UIWindow) {
        guard !hingeWindows.contains(window) else { return }
        hingeWindows.add(window)
        window.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
    }

    static func supportedOrientations(in window: UIWindow?) -> UIInterfaceOrientationMask {
        if window?.traitCollection.userInterfaceIdiom == .pad { return .all }
        return window.map { hingeWindows.contains($0) } == true ? .allButUpsideDown : .portrait
    }
}

/// Keeps hardware capability separate from layout size, which changes on either display.
struct PlatformWorkspaceGeometryObserver: UIViewRepresentable {
    let onFoldSidebarWidthChange: (CGFloat?) -> Void

    func makeUIView(context: Context) -> GeometryView {
        GeometryView(onFoldSidebarWidthChange: onFoldSidebarWidthChange)
    }

    func updateUIView(_ view: GeometryView, context: Context) {
        view.onFoldSidebarWidthChange = onFoldSidebarWidthChange
    }

    final class GeometryView: UIView {
        var onFoldSidebarWidthChange: (CGFloat?) -> Void
        private var hasHinge = false
        private var lastFoldSidebarWidth: CGFloat?

        init(onFoldSidebarWidthChange: @escaping (CGFloat?) -> Void) {
            self.onFoldSidebarWidthChange = onFoldSidebarWidthChange
            super.init(frame: .zero)
            isUserInteractionEnabled = false
            #if canImport(UIKit, _version: 9127.0.85)
            if #available(iOS 27.1, *) {
                addInteraction(UIHingeInteraction { [weak self] _, update in
                    guard let self else { return }
                    // Capability survives a fold and temporary window detachment.
                    hasHinge = hasHinge || update.hinge != nil
                    updateGeometry()
                })
            }
            #endif
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { nil }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            updateGeometry()
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            updateGeometry()
        }

        private func updateGeometry() {
            guard let window else { return }
            if hasHinge { PlatformWorkspaceOrientation.allowHingeOrientations(in: window) }
            var foldSidebarWidth: CGFloat?
            #if canImport(UIKit, _version: 9127.0.85)
            if #available(iOS 27.1, *) {
                for region in reservedRegions(kind: .division) where region.isActive {
                    let frame = region.frame.intersection(bounds)
                    guard !frame.isNull, frame.height >= bounds.height / 2 else { continue }
                    let leading = effectiveUserInterfaceLayoutDirection == .rightToLeft
                        ? bounds.maxX - frame.maxX : frame.minX - bounds.minX
                    let trailing = bounds.width - leading - frame.width
                    let rtl = effectiveUserInterfaceLayoutDirection == .rightToLeft
                    let leadingInset = rtl ? safeAreaInsets.right : safeAreaInsets.left
                    let trailingInset = rtl ? safeAreaInsets.left : safeAreaInsets.right
                    guard leading - leadingInset >= T3Metrics.minimumSidebarWidth,
                          trailing - trailingInset >= 320 else { continue }
                    foldSidebarWidth = leading
                    break
                }
            }
            #endif
            guard lastFoldSidebarWidth != foldSidebarWidth else { return }
            lastFoldSidebarWidth = foldSidebarWidth
            // Layout may run during a SwiftUI update. Publish only the final reservation.
            DispatchQueue.main.async { [weak self] in
                guard let self, lastFoldSidebarWidth == foldSidebarWidth else { return }
                onFoldSidebarWidthChange(foldSidebarWidth)
            }
        }
    }
}
