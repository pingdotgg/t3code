#if DEBUG
    import AppKit
    import SwiftUI

    /// Which Alpine menus have opened this run. SwiftUI's accessibility tree
    /// does not resolve for same-process clients (see `UIProbeHooks`), so the
    /// menus name themselves here — same reporting pattern as
    /// `UIProbeGitStrip` — and the probe asserts on that rather than on pixels.
    /// It also means the AXShowMenu invocation path cannot be driven from a
    /// probe; it is covered by `AlpineContextMenuTests` instead.
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
    /// Every row of the table is probed, scrolling to reach the ones below the
    /// fold, and the fixture is arranged (a settled session seeded, its
    /// disclosure opened) so that all four menu variants actually exist —
    /// project, thread/settle, thread/unsettle, settled-disclosure. Probing a
    /// prefix of the rows instead would leave whole variants unexercised while
    /// still reporting a pass.
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
            let pass: Int
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
            await seedSettledSession(model: model, table: table)

            // The row → content mapping is SwiftUI's business (section headers,
            // thread rows and disclosure rows share one table), so every row in
            // the table is probed — scrolling to reach the ones below the fold —
            // and each is identified by the menu that opened. Probing only the
            // rows that happen to start on screen would leave whole menu
            // variants unexercised while still reporting a pass.
            var readings = await walkRows(table: table, window: window, dir: dir, pass: 1)

            // Settled sessions live behind a closed disclosure, so their rows
            // are not in the table at all on the first pass — and their menu is
            // the "Mark as Active" variant, which nothing else exercises. Open
            // the disclosure and walk again.
            if readings.contains(where: { $0.identity.hasPrefix("settled:") }) {
                if await revealSettledDisclosure(in: table) {
                    readings += await walkRows(table: table, window: window, dir: dir, pass: 2)
                } else {
                    UIProbeAssertions.fail(
                        "sidebar-settled-rows", "the settled disclosure never opened")
                }
            }

            for reading in readings {
                print(
                    "UIProbe:   pass \(reading.pass) row \(reading.row): "
                        + "\(reading.identity) [\(reading.text)]")
            }

            check("sidebar-project-menu", readings, prefix: "project:")
            check("sidebar-thread-menu", readings, prefix: "thread:")
            check("sidebar-settled-menu", readings, prefix: "settled:")
            // Settle and un-settle share one row in the menu, so both branches
            // have to be seen for the slot to count as covered.
            check("sidebar-thread-menu-settle", readings, contains: ":settle")
            check("sidebar-thread-menu-unsettle", readings, contains: ":unsettle")
            // Every popover that opened has to be one of ours. An unidentified
            // one means a menu rendered without going through the Alpine views.
            let unidentified = readings.filter(\.identity.isEmpty).map(\.row)
            if unidentified.isEmpty {
                UIProbeAssertions.pass(
                    "sidebar-menus-are-alpine", "\(readings.count) popover(s), all self-reported")
            } else {
                UIProbeAssertions.fail(
                    "sidebar-menus-are-alpine",
                    "rows \(unidentified) opened a popover no Alpine menu claims")
            }
            if nativeMenuWindow() != nil {
                UIProbeAssertions.fail(
                    "sidebar-no-native-menu", "a native NSMenu window is on screen")
            } else {
                UIProbeAssertions.pass("sidebar-no-native-menu", "no NSMenu window appeared")
            }
            finish(dir: dir)
        }

        /// Walks every row in the table, scrolling to reach the ones below the
        /// fold. Probing only the rows that happen to start on screen would
        /// leave whole menu variants unexercised while still reporting a pass,
        /// so the row count is logged and an unreachable row fails the run.
        private static func walkRows(
            table: NSTableView,
            window: NSWindow,
            dir: String,
            pass: Int
        ) async -> [MenuReading] {
            let total = table.numberOfRows
            print("UIProbe: sidebar-menus pass \(pass) table rows=\(total)")
            var readings: [MenuReading] = []
            var rowsWithoutMenu: [Int] = []
            var unreachableRows: [Int] = []
            for row in 0..<total {
                guard let rect = await scrollIntoView(row: row, in: table) else {
                    unreachableRows.append(row)
                    continue
                }
                guard
                    let reading = await openMenu(
                        row: row, rect: rect, in: table, window: window, dir: dir, pass: pass)
                else {
                    rowsWithoutMenu.append(row)
                    continue
                }
                readings.append(reading)
                await dismissPopover(in: window)
            }
            print(
                "UIProbe: sidebar-menus pass \(pass) probed \(readings.count) of \(total) row(s)")
            // Coverage is stated, never implied: a row that opened nothing is a
            // legitimate answer (the empty-state row has no menu), a row that
            // could not be reached is not.
            if !rowsWithoutMenu.isEmpty {
                print("UIProbe: sidebar-menus pass \(pass) rows with no menu=\(rowsWithoutMenu)")
            }
            if unreachableRows.isEmpty {
                UIProbeAssertions.pass(
                    "sidebar-menu-coverage-\(pass)", "all \(total) row(s) reached")
            } else {
                UIProbeAssertions.fail(
                    "sidebar-menu-coverage-\(pass)",
                    "rows \(unreachableRows) never scrolled into view")
            }
            return readings
        }

        private static func check(_ name: String, _ readings: [MenuReading], prefix: String) {
            report(
                name, readings.first { $0.identity.hasPrefix(prefix) },
                missing: "no row opened an Alpine \(prefix.dropLast()) menu")
        }

        private static func check(_ name: String, _ readings: [MenuReading], contains: String) {
            report(
                name, readings.first { $0.identity.contains(contains) },
                missing: "no menu reported \(contains)")
        }

        private static func report(_ name: String, _ reading: MenuReading?, missing: String) {
            guard let reading else {
                UIProbeAssertions.fail(name, missing)
                return
            }
            UIProbeAssertions.pass(
                name, "pass \(reading.pass) row \(reading.row) → \(reading.identity)")
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

        // MARK: - Fixture

        /// The settled disclosure row carries the third menu this PR moved onto
        /// the Alpine surface, and it only exists once a project has a settled
        /// session — which the mock fixture does not seed. Settle one, so the
        /// variant is exercised instead of permanently skipped.
        private static func seedSettledSession(model: AppModel, table: NSTableView) async {
            guard
                let thread = model.threads.last(where: { ThreadInboxSemantics.canSettle($0) })
            else {
                print("UIProbe: sidebar-menus no settleable thread to seed")
                return
            }
            let rowsBefore = table.numberOfRows
            await model.settleThread(thread)
            // The list re-sorts under `Motion.structure`, so wait for the table
            // to actually restructure rather than racing the animation.
            for _ in 0..<20 {
                try? await Task.sleep(for: .milliseconds(150))
                if model.threads.first(where: { $0.id == thread.id })?.status == .settled,
                    table.numberOfRows > 0
                {
                    break
                }
            }
            try? await Task.sleep(for: .milliseconds(500))
            print(
                "UIProbe: sidebar-menus seeded settled=\(thread.id) "
                    + "rows \(rowsBefore)→\(table.numberOfRows)")
        }

        // MARK: - Driving the menu

        /// Right-clicks `row` and, if a popover opens, captures it and returns
        /// what it says. Nil means that row has no secondary-click menu, which
        /// is a legitimate answer for the search field or an empty-state row.
        private static func openMenu(
            row: Int,
            rect: NSRect,
            in table: NSTableView,
            window: NSWindow,
            dir: String,
            pass: Int
        ) async -> MenuReading? {
            UIProbeMenus.reset()
            let center = NSPoint(x: rect.midX, y: rect.midY)
            postSecondaryClick(in: window, at: table.convert(center, to: nil))
            guard let popover = await waitForPopover() else { return nil }
            // The window's theme frame carries the system's own glass rim,
            // which `cacheDisplay` renders as a saturated halo; the content
            // capture is the one that shows the menu as the user sees it.
            let name = "menu-p\(pass)-row\(row)"
            snapshot(name, window: popover, themeFrame: true, dir: dir)
            snapshot("\(name)-content", window: popover, themeFrame: false, dir: dir)
            return MenuReading(
                pass: pass,
                row: row,
                identity: UIProbeMenus.opened.joined(separator: "+"),
                text: accessibleText(in: popover))
        }

        /// Opens every project's settled disclosure so the rows it hides join
        /// the table and get probed. Driven through the probe's toggle
        /// notification rather than a synthesized click on the chevron: the
        /// disclosure state is SwiftUI `@UIState` with no other in-process
        /// entry point, and hunting a 12pt glyph by coordinate would fail for
        /// reasons that have nothing to do with the menus. Returns whether the
        /// table actually grew — a reveal that silently did nothing must not
        /// read as "no settled rows exist".
        private static func revealSettledDisclosure(in table: NSTableView) async -> Bool {
            let before = table.numberOfRows
            NotificationCenter.default.post(name: .uiProbeToggleSection, object: "settled")
            for _ in 0..<20 {
                try? await Task.sleep(for: .milliseconds(150))
                guard table.numberOfRows > before else { continue }
                // Let the disclosure's insert animation settle before rows are
                // measured for clicking.
                try? await Task.sleep(for: .milliseconds(600))
                print(
                    "UIProbe: sidebar-menus revealed settled rows "
                        + "\(before)→\(table.numberOfRows)")
                return true
            }
            return false
        }

        private static func postSecondaryClick(in window: NSWindow, at point: NSPoint) {
            postMouse([.rightMouseDown, .rightMouseUp], in: window, at: point)
        }

        /// Events go through the queue rather than straight to a view: the
        /// context-menu catcher decides whether to claim a click by inspecting
        /// `NSApp.currentEvent`, which only the normal dequeue path sets.
        private static func postMouse(
            _ types: [NSEvent.EventType], in window: NSWindow, at point: NSPoint
        ) {
            for type in types {
                let isDown = type == .rightMouseDown || type == .leftMouseDown
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
                        pressure: isDown ? 1 : 0)
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

        /// Brings `row` on screen and returns its rect, or nil if it never got
        /// there. The rect is returned rather than re-read by the caller because
        /// scrolling moves it, and clicking a stale rect would land on whichever
        /// row now occupies that spot.
        private static func scrollIntoView(row: Int, in table: NSTableView) async -> NSRect? {
            table.scrollRowToVisible(row)
            for _ in 0..<15 {
                try? await Task.sleep(for: .milliseconds(100))
                let rect = table.rect(ofRow: row)
                guard !rect.isEmpty else { continue }
                // Containment of the exact point about to be clicked, not mere
                // intersection: a row peeking one pixel past the fold would
                // otherwise send the click to the clip view's edge.
                if table.visibleRect.contains(NSPoint(x: rect.midX, y: rect.midY)) {
                    return rect
                }
            }
            return nil
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
