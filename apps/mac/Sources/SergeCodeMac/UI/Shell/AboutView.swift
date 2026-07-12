import AppKit
import SwiftUI

/// Presents the About window through AppKit. The SwiftUI alternatives both
/// fail here: a `Window` scene needs `openWindow`, and reading
/// `@Environment(\.openWindow)` from a view inside a `CommandGroup` crashes
/// AppKit menu layout on the macOS 27 beta SDK.
@MainActor
final class AboutWindowController {
    static let shared = AboutWindowController()
    private var window: NSWindow?

    func show() {
        if window == nil {
            let hosting = NSHostingController(rootView: AboutView())
            let panel = NSWindow(contentViewController: hosting)
            panel.styleMask = [.titled, .closable, .fullSizeContentView]
            panel.titlebarAppearsTransparent = true
            panel.titleVisibility = .hidden
            panel.title = "About SurgeCode"
            panel.isReleasedWhenClosed = false
            panel.setContentSize(NSSize(width: 380, height: 460))
            panel.center()
            window = panel
        }
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}

struct AboutView: View {
    private let githubURL = URL(string: "https://github.com/SergeSerb2/SergeCode")!

    var body: some View {
        ZStack {
            aboutGradient
                .opacity(0.82)
                .ignoresSafeArea()

            VStack(spacing: 20) {
                BrandMarkView(style: .fullColor)
                    .frame(width: 96, height: 96)
                    .padding(14)
                    .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 20))

                BrandWordmark(size: 28)

                VStack(spacing: 5) {
                    Text(Bundle.main.appVersionDisplay)
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    if let copyright {
                        Text(copyright)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }

                Link("GitHub", destination: githubURL)
                    .font(.caption)
            }
            .padding(32)
        }
        .frame(width: 380, height: 460)
    }

    private var aboutGradient: LinearGradient {
        let pair = AlpineTheme.dolomitesGradientPairs[0]
        return LinearGradient(
            colors: [pair.top.color, pair.bottom.color],
            startPoint: .topLeading,
            endPoint: .bottomTrailing)
    }

    private var copyright: String? {
        guard let value = Bundle.main.infoDictionary?["NSHumanReadableCopyright"] as? String,
            !value.isEmpty
        else { return nil }
        return value
    }
}
