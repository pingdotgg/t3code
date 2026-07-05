#if DEBUG
    import AppKit
    import SwiftUI

    /// Debug-only UI verification hook for agent/CI runs without screen
    /// recording or accessibility permissions: `SERGECODE_UI_PROBE=<dir>`
    /// (typically with `--mock`) selects the first thread, self-captures the
    /// window to PNGs in `<dir>` (in-process bitmap, no TCC prompt), drives
    /// the diff panel's horizontal scroller programmatically, logs the
    /// scrollable geometry to stdout, and quits.
    @MainActor
    enum UIProbe {
        static func runIfRequested(model: AppModel) {
            guard let dir = ProcessInfo.processInfo.environment["SERGECODE_UI_PROBE"],
                !dir.isEmpty
            else { return }
            Task { await run(model: model, dir: dir) }
        }

        private static func run(model: AppModel, dir: String) async {
            try? FileManager.default.createDirectory(
                atPath: dir, withIntermediateDirectories: true)

            // Let the mock backend load, then select a thread so the
            // inspector has content.
            try? await Task.sleep(for: .seconds(2))
            if model.selectedThreadID == nil {
                model.selectedThreadID = model.threads.first?.id
            }
            // Let the inspector present and the diff refresh land.
            try? await Task.sleep(for: .seconds(2))
            snapshot("1-inspector-diff", dir: dir)

            if let diffScroll = widestScrollView() {
                let doc = diffScroll.documentView?.frame.width ?? 0
                let clip = diffScroll.contentView.bounds.width
                print("UIProbe: diff doc width=\(doc) clip width=\(clip)")
                let overflow = max(0, doc - clip)
                diffScroll.contentView.scroll(to: NSPoint(x: overflow, y: 0))
                diffScroll.reflectScrolledClipView(diffScroll.contentView)
                print("UIProbe: scrolled to x=\(diffScroll.contentView.bounds.origin.x)")
                try? await Task.sleep(for: .seconds(1))
                snapshot("2-diff-hscrolled", dir: dir)
            } else {
                print("UIProbe: no horizontally scrollable diff view found")
            }

            print("UIProbe: done")
            NSApp.terminate(nil)
        }

        /// The diff panel's PanScrollView: the scroll view whose document
        /// extends furthest past its viewport horizontally.
        private static func widestScrollView() -> NSScrollView? {
            guard let root = NSApp.windows.first(where: { $0.isVisible })?.contentView
            else { return nil }
            return scrollViews(in: root)
                .filter { ($0.documentView?.frame.width ?? 0) > $0.contentView.bounds.width }
                .max { a, b in
                    let overA = (a.documentView?.frame.width ?? 0) - a.contentView.bounds.width
                    let overB = (b.documentView?.frame.width ?? 0) - b.contentView.bounds.width
                    return overA < overB
                }
        }

        private static func scrollViews(in view: NSView) -> [NSScrollView] {
            var found: [NSScrollView] = []
            for subview in view.subviews {
                if let scroll = subview as? NSScrollView { found.append(scroll) }
                found += scrollViews(in: subview)
            }
            return found
        }

        private static func snapshot(_ name: String, dir: String) {
            guard let window = NSApp.windows.first(where: { $0.isVisible }),
                let view = window.contentView,
                let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds)
            else {
                print("UIProbe: snapshot \(name) failed (no window)")
                return
            }
            view.cacheDisplay(in: view.bounds, to: rep)
            guard let data = rep.representation(using: .png, properties: [:]) else { return }
            let url = URL(fileURLWithPath: dir).appendingPathComponent("\(name).png")
            try? data.write(to: url)
            print("UIProbe: wrote \(url.path)")
        }
    }
#endif
