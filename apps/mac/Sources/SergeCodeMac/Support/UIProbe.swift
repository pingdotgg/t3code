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
            // inspector has content. Prefer thread-1: it's the one the mock
            // seeds with plan progress, so the plan strip is exercised too.
            try? await Task.sleep(for: .seconds(2))
            if model.selectedThreadID == nil {
                model.selectedThreadID =
                    model.threads.first { $0.id == "thread-1" }?.id ?? model.threads.first?.id
            }
            // Let the inspector present and the diff refresh land.
            try? await Task.sleep(for: .seconds(2))
            snapshot("1-inspector-diff", dir: dir)

            // Plan strip above the composer: expand, snapshot, collapse.
            toggleSection("plan")
            try? await Task.sleep(for: .seconds(1))
            snapshot("2-plan-expanded", dir: dir)
            toggleSection("plan")
            try? await Task.sleep(for: .seconds(1))

            // Checkpoints section under the diff: expand and snapshot.
            toggleSection("checkpoints")
            try? await Task.sleep(for: .seconds(1))
            snapshot("3-checkpoints-expanded", dir: dir)
            toggleSection("checkpoints")
            try? await Task.sleep(for: .seconds(1))

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

        /// Toggles a collapsible section via the probe notification hook
        /// (see UIProbeHooks.swift) — SwiftUI's AX tree doesn't resolve for
        /// same-process clients, so buttons can't be pressed through AX here.
        private static func toggleSection(_ key: String) {
            NotificationCenter.default.post(name: .uiProbeToggleSection, object: key)
            print("UIProbe: toggled section '\(key)'")
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
