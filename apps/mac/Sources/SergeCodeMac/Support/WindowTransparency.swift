import AppKit
import SwiftUI

/// Makes the hosting `NSWindow` eligible for true behind-window translucency:
/// non-opaque, clear background. Shadow and input behavior stay normal.
///
/// SwiftUI's `.containerBackground(.thinMaterial, for: .window)` alone paints a
/// frosted plate that does not sample the desktop when the window remains
/// opaque (AppKit default). Pair this configurator with
/// `WindowGlassBackground` so `sceneryTranslucency < 1` reveals the desktop.
struct TransparentWindowConfigurator: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let view = WindowProbeView()
        view.onWindowChange = Self.applyTransparency
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        Self.applyTransparency(to: nsView.window)
    }

    static func applyTransparency(to window: NSWindow?) {
        guard let window else { return }
        // Keep main-window semantic colors aligned with SurgeCode's dark UI,
        // independently of macOS's system appearance.
        if let darkAppearance = NSAppearance(named: .darkAqua),
            window.appearance?.name != darkAppearance.name
        {
            window.appearance = darkAppearance
        }
        // Only main document-style windows — leave Settings / panels alone.
        guard window.styleMask.contains(.titled),
            window.styleMask.contains(.resizable)
        else { return }

        if window.isOpaque {
            window.isOpaque = false
        }
        if window.backgroundColor != .clear {
            window.backgroundColor = .clear
        }
        // Ensure the root layer doesn't re-introduce an opaque plate.
        if let content = window.contentView {
            content.wantsLayer = true
            if content.layer?.backgroundColor != NSColor.clear.cgColor {
                content.layer?.backgroundColor = NSColor.clear.cgColor
            }
        }
    }

    /// Reports whether a window is configured for behind-window glass
    /// (used by UIProbe verification).
    static func isConfigured(_ window: NSWindow) -> Bool {
        !window.isOpaque
            && window.backgroundColor == .clear
    }
}

/// Pins a SwiftUI-hosted NSWindow to SurgeCode's dark visual language without
/// changing macOS's system-wide appearance. Re-applies after AppKit attaches
/// or reparents the hosting view.
struct DarkAppearanceConfigurator: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let view = WindowProbeView()
        view.onWindowChange = Self.applyAppearance
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        Self.applyAppearance(to: nsView.window)
    }

    static func applyAppearance(to window: NSWindow?) {
        guard let window, let darkAppearance = NSAppearance(named: .darkAqua) else { return }
        if window.appearance?.name != darkAppearance.name {
            window.appearance = darkAppearance
        }
    }
}

/// Host view that re-applies transparency whenever AppKit attaches a window
/// (SwiftUI can reparent before the first `window` is non-nil).
private final class WindowProbeView: NSView {
    var onWindowChange: ((NSWindow?) -> Void)?

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        onWindowChange?(window)
    }
}

/// Behind-window visual effect plus the window plate (`GlassLayering`).
///
/// The plate is the window-wide layer, so it sits *under* the scenery
/// wallpaper as well as under the chrome columns: any alpha it spends is alpha
/// the desktop can never reach, no matter how translucent the scene is. It is
/// therefore held at zero through the glass band and only ramps in above
/// `GlassLayering.plateStart`, landing fully opaque at `1.0` (the historical
/// solid window). Below that, chrome sits directly on the blurred desktop and
/// the scene carries the app's coverage.
struct WindowGlassBackground: View {
    /// Scenery photo / glass solidity in `ScenerySettingsFile.translucencyRange`.
    var translucency: Double

    var body: some View {
        let plate = GlassLayering.windowPlate(translucency: translucency)

        if plate >= 0.999 {
            Rectangle()
                .fill(Color(nsColor: .windowBackgroundColor))
                .ignoresSafeArea()
        } else {
            ZStack {
                BehindWindowVisualEffect(
                    material: .underWindowBackground,
                    state: .active)

                if plate > 0 {
                    Rectangle()
                        .fill(Color(nsColor: .windowBackgroundColor))
                        .opacity(plate)
                }
            }
            .ignoresSafeArea()
        }
    }
}

/// `NSVisualEffectView` configured to sample content *behind the window*
/// (desktop and other apps), not merely the views underneath in-app.
struct BehindWindowVisualEffect: NSViewRepresentable {
    var material: NSVisualEffectView.Material = .underWindowBackground
    var state: NSVisualEffectView.State = .active

    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.blendingMode = .behindWindow
        view.material = material
        view.state = state
        view.isEmphasized = true
        // Transparent so the effect itself is the fill, not a subview plate.
        view.wantsLayer = true
        view.layer?.backgroundColor = NSColor.clear.cgColor
        return view
    }

    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {
        nsView.material = material
        nsView.state = state
        if nsView.blendingMode != .behindWindow {
            nsView.blendingMode = .behindWindow
        }
    }
}

#if DEBUG
    extension TransparentWindowConfigurator {
        /// Walks the view tree counting behind-window visual effect views.
        static func behindWindowEffectCount(in root: NSView?) -> Int {
            guard let root else { return 0 }
            var count = 0
            func walk(_ view: NSView) {
                if let effect = view as? NSVisualEffectView,
                    effect.blendingMode == .behindWindow
                {
                    count += 1
                }
                for sub in view.subviews { walk(sub) }
            }
            walk(root)
            return count
        }
    }
#endif
