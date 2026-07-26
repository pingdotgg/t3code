#if DEBUG
    import AppKit
    import SwiftUI

    /// Which Alpine menus have opened this run. SwiftUI does not expose a
    /// popover's row labels through the headless accessibility tree, so the
    /// menus name themselves here (same reporting pattern as
    /// `UIProbeGitStrip`) and the probe asserts on that rather than on pixels.
    @MainActor
    enum UIProbeMenus {
        private(set) static var opened: [String] = []

        static func record(_ menu: String) {
            opened.append(menu)
            print("UIProbe: menu opened \(menu)")
        }

        static func reset() {
            opened = []
        }
    }

    /// `SERGECODE_UI_PROBE_SCENARIO=sidebar-menus` — proves the sidebar's
    /// secondary-click menus are the app's own popovers rather than native
    /// `NSMenu`s, and captures them.
    ///
    /// A right-click is synthesized into the event queue (not handed straight
    /// to a view) because `AlpineContextMenu`'s catcher decides whether to
    /// claim the click by inspecting `NSApp.currentEvent`, which only the
    /// normal dequeue path sets. That also makes the check honest about the
    /// failure mode it exists for: a native menu would open a modal event
    /// tracking loop here, so a regression shows up as the watchdog firing
    /// rather than as a quietly passing run.
    @MainActor
    enum SidebarMenuProbe {
        /// What a captured popover turned out to be: the menu identity the view
        /// itself reported, plus whatever text the accessibility tree gave up
        /// (often nothing, headless — logged for diagnosis, never asserted on).
        private struct MenuReading {
            let row: Int
            let identity: String
            let text: String
        }

        static func run(multi: MultiDeviceModel, scenery: SceneryStore, dir: String) async {
            let model = multi.local
            try? FileManager.default.createDirectory(
                atPath: dir, withIntermediateDirectories: true)
            try? await Task.sleep(for: .seconds(2))
            if model.selectedThreadID == nil,
                let threadID = model.threads.first(where: { $0.id == "thread-1" })?.id
                    ?? model.threads.first?.id
            {
                multi.select(threadID: threadID, on: model.deviceID)
            }
            try? await Task.sleep(for: .seconds(2))

            guard let window = NSApp.windows.first(where: { $0.isVisible }) else {
                UIProbeAssertions.fail("sidebar-menus", "no visible window")
                finish(dir: dir)
                return
            }
            guard let table = sidebarTable(in: window) else {
                UIProbeAssertions.fail("sidebar-menus", "no sidebar table view")
                finish(dir: dir)
                return
            }

            // The row → content mapping is SwiftUI's business (section headers
            // and thread rows share one table), so every visible row is probed
            // and identified by what its menu says.
            var readings: [MenuReading] = []
            for row in visibleRows(of: table).prefix(8) {
                guard let reading = await openMenu(row: row, in: table, window: window, dir: dir)
                else { continue }
                readings.append(reading)
                await dismissPopover(in: window)
            }

            print("UIProbe: sidebar-menus probed \(readings.count) row menu(s)")
            for reading in readings {
                print("UIProbe:   row \(reading.row): \(reading.identity) [\(reading.text)]")
            }

            check("sidebar-project-menu", readings, prefix: "project:")
            check("sidebar-thread-menu", readings, prefix: "thread:")
            if nativeMenuWindow() != nil {
                UIProbeAssertions.fail(
                    "sidebar-no-native-menu", "a native NSMenu window is on screen")
            } else {
                UIProbeAssertions.pass("sidebar-no-native-menu", "no NSMenu window appeared")
            }
            finish(dir: dir)
        }

        private static func check(_ name: String, _ readings: [MenuReading], prefix: String) {
            guard let reading = readings.first(where: { $0.identity.hasPrefix(prefix) }) else {
                UIProbeAssertions.fail(
                    name, "no row opened an Alpine \(prefix.dropLast()) menu")
                return
            }
            UIProbeAssertions.pass(name, "row \(reading.row) → \(reading.identity)")
        }

        private static func finish(dir: String) {
            _ = UIProbeAssertions.verdict()
            let failures = UIProbeAssertions.failures
            print(
                failures.isEmpty
                    ? "UIProbe: done"
                    : "UIProbe: done FAIL=\(failures.joined(separator: ","))")
            NSApp.terminate(nil)
        }

        // MARK: - Driving the menu

        /// Right-clicks `row` and, if a popover opens, captures it and returns
        /// what it says. Nil means that row has no secondary-click menu, which
        /// is a legitimate answer for the search field or an empty-state row.
        private static func openMenu(
            row: Int,
            in table: NSTableView,
            window: NSWindow,
            dir: String
        ) async -> MenuReading? {
            let rect = table.rect(ofRow: row)
            guard !rect.isEmpty else { return nil }
            UIProbeMenus.reset()
            let center = NSPoint(x: rect.midX, y: rect.midY)
            postSecondaryClick(in: window, at: table.convert(center, to: nil))
            guard let popover = await waitForPopover() else { return nil }
            // The window's theme frame carries the system's own glass rim,
            // which `cacheDisplay` renders as a saturated halo; the content
            // capture is the one that shows the menu as the user sees it.
            snapshot("menu-row\(row)", window: popover, themeFrame: true, dir: dir)
            snapshot("menu-row\(row)-content", window: popover, themeFrame: false, dir: dir)
            return MenuReading(
                row: row,
                identity: UIProbeMenus.opened.joined(separator: "+"),
                text: accessibleText(in: popover))
        }

        private static func postSecondaryClick(in window: NSWindow, at point: NSPoint) {
            for type in [NSEvent.EventType.rightMouseDown, .rightMouseUp] {
                guard
                    let event = NSEvent.mouseEvent(
                        with: type,
                        location: point,
                        modifierFlags: [],
                        timestamp: ProcessInfo.processInfo.systemUptime,
                        windowNumber: window.windowNumber,
                        context: nil,
                        eventNumber: 0,
                        clickCount: 1,
                        pressure: type == .rightMouseDown ? 1 : 0)
                else { continue }
                NSApp.postEvent(event, atStart: false)
            }
        }

        private static func waitForPopover() async -> NSWindow? {
            for _ in 0..<20 {
                try? await Task.sleep(for: .milliseconds(100))
                if let popover = popoverWindow() { return popover }
            }
            return nil
        }

        private static func dismissPopover(in window: NSWindow) async {
            guard let popover = popoverWindow() else { return }
            popover.performClose(nil)
            for _ in 0..<10 {
                try? await Task.sleep(for: .milliseconds(100))
                if popoverWindow() == nil { return }
            }
            // A popover that refuses `performClose` still has to go, or every
            // later row would read the stale menu.
            popover.close()
            try? await Task.sleep(for: .milliseconds(200))
        }

        private static func popoverWindow() -> NSWindow? {
            NSApp.windows.first { window in
                window.isVisible
                    && String(describing: type(of: window)).contains("Popover")
            }
        }

        /// A native context menu runs in its own `NSPopupMenuWindow` — a
        /// different class from the popover's, so its absence is checkable.
        private static func nativeMenuWindow() -> NSWindow? {
            NSApp.windows.first { window in
                window.isVisible
                    && String(describing: type(of: window)).contains("PopupMenu")
            }
        }

        // MARK: - Locating the sidebar

        /// The sidebar list, taken as the leftmost table view in the window —
        /// the inspector hosts lists of its own further right.
        private static func sidebarTable(in window: NSWindow) -> NSTableView? {
            guard let root = window.contentView else { return nil }
            var found: [NSTableView] = []
            func walk(_ view: NSView) {
                if let table = view as? NSTableView { found.append(table) }
                for subview in view.subviews { walk(subview) }
            }
            walk(root)
            return found.min { lhs, rhs in
                lhs.convert(lhs.bounds, to: nil).minX < rhs.convert(rhs.bounds, to: nil).minX
            }
        }

        private static func visibleRows(of table: NSTableView) -> [Int] {
            let range = table.rows(in: table.visibleRect)
            guard range.length > 0 else { return [] }
            return Array(range.location..<(range.location + range.length))
        }

        // MARK: - Reading and capturing

        /// SwiftUI in a headless probe exposes row labels through the
        /// accessibility tree, not through `NSTextField` subviews, so walk both
        /// (mirroring `UIProbe.accessibleText`).
        private static func accessibleText(in window: NSWindow) -> String {
            var parts: [String] = []
            var visited = Set<ObjectIdentifier>()

            func append(_ value: String?) {
                guard let value, !value.isEmpty, !parts.contains(value) else { return }
                parts.append(value)
            }

            func visit(_ object: AnyObject) {
                guard visited.insert(ObjectIdentifier(object)).inserted else { return }
                if let view = object as? NSView {
                    if let textField = view as? NSTextField { append(textField.stringValue) }
                    append(view.accessibilityLabel())
                    append(view.accessibilityTitle())
                    append(view.accessibilityValue() as? String)
                    for subview in view.subviews { visit(subview) }
                    for child in view.accessibilityChildren() ?? [] {
                        visitChild(child)
                    }
                } else if let element = object as? NSAccessibilityElement {
                    append(element.accessibilityLabel())
                    append(element.accessibilityTitle())
                    append(element.accessibilityValue() as? String)
                    for child in element.accessibilityChildren() ?? [] {
                        visitChild(child)
                    }
                }
            }

            func visitChild(_ child: Any) {
                if let view = child as? NSView {
                    visit(view)
                } else if let element = child as? NSAccessibilityElement {
                    visit(element)
                }
            }

            if let root = window.contentView { visit(root) }
            return parts.joined(separator: " | ")
        }

        private static func snapshot(
            _ name: String, window: NSWindow, themeFrame: Bool, dir: String
        ) {
            let root = themeFrame ? window.contentView?.superview ?? window.contentView
                : window.contentView
            guard let view = root,
                let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds)
            else {
                print("UIProbe: snapshot \(name) failed (no view)")
                return
            }
            view.cacheDisplay(in: view.bounds, to: rep)
            guard let data = rep.representation(using: .png, properties: [:]) else {
                print("UIProbe: FAIL encode \(name)")
                return
            }
            let url = URL(fileURLWithPath: dir).appendingPathComponent("\(name).png")
            do {
                try data.write(to: url)
                print("UIProbe: wrote \(url.path)")
            } catch {
                print("UIProbe: FAIL write \(url.path): \(error)")
            }
        }
    }
#endif
