#if DEBUG
    import AppKit
    import SwiftUI

    /// `SERGECODE_UI_PROBE_SCENARIO=sidebar-snooze` — drives the whole snooze
    /// flow end to end against the mock backend: right-click a thread row,
    /// open the Snooze submenu page, pick the first preset, and verify the
    /// thread leaves the active list for the project's "Snoozed" disclosure —
    /// then wakes it and verifies it returns.
    ///
    /// Clicks are synthesized into the event queue like `SidebarMenuProbe`'s.
    /// Inside the popover the probe first tries a real click on the row's
    /// accessibility frame; when the headless tree gives up no frame (SwiftUI
    /// often resolves none for same-process clients) it falls back to the
    /// `.uiProbeMenuAction` hook, which runs the same action the row's button
    /// runs — and says so in the log, so a pass is honest about which path it
    /// proved.
    @MainActor
    enum SidebarSnoozeProbe {
        static func run(multi: MultiDeviceModel, scenery: SceneryStore, dir: String) async {
            let model = multi.local
            try? FileManager.default.createDirectory(
                atPath: dir, withIntermediateDirectories: true)
            try? await Task.sleep(for: .seconds(2))

            guard let window = NSApp.windows.first(where: { $0.isVisible }) else {
                UIProbeAssertions.fail("sidebar-snooze", "no visible window")
                finish()
                return
            }
            guard let table = await UIProbeSidebar.waitForTable(in: window) else {
                UIProbeAssertions.fail("sidebar-snooze", "no sidebar table view")
                finish()
                return
            }
            guard
                let target = model.threads.first(where: {
                    $0.status == .idle && !ThreadInboxSemantics.isSnoozed($0)
                }) ?? model.threads.first(where: { !ThreadInboxSemantics.isSnoozed($0) })
            else {
                UIProbeAssertions.fail("sidebar-snooze", "no snoozable thread in the fixture")
                finish()
                return
            }
            print("UIProbe: sidebar-snooze target=\(target.id)")

            // 1. Right-click until the target thread's menu opens.
            guard let popover = await openThreadMenu(for: target.id, table: table, window: window)
            else {
                UIProbeAssertions.fail(
                    "sidebar-snooze-menu", "no row opened thread \(target.id)'s menu")
                finish()
                return
            }
            UIProbeAssertions.pass("sidebar-snooze-menu", "menu open for \(target.id)")
            snapshot("snooze-1-menu", window: popover, dir: dir)

            // 2. Open the Snooze page: real click when the accessibility tree
            //    yields a frame, probe hook otherwise.
            if !(await clickElement(titled: "Snooze", in: popover)) {
                print("UIProbe: sidebar-snooze falling back to menu-action hook for Snooze row")
                NotificationCenter.default.post(
                    name: .uiProbeMenuAction, object: "snooze-page:\(target.id)")
            }
            let pageOpened = await UIProbeWait.until {
                UIProbeMenus.opened.contains("thread:\(target.id):snooze-page")
            }
            if pageOpened {
                UIProbeAssertions.pass("sidebar-snooze-page", "snooze page rendered")
            } else {
                UIProbeAssertions.fail(
                    "sidebar-snooze-page",
                    "the Snooze row never swapped the menu to the preset page")
            }
            snapshot("snooze-2-presets", window: popover, dir: dir)

            // 3. Commit the first preset ("In 1 Hour").
            if pageOpened, !(await clickElement(titled: "In 1 Hour", in: popover)) {
                print("UIProbe: sidebar-snooze falling back to menu-action hook for the preset")
                NotificationCenter.default.post(
                    name: .uiProbeMenuAction, object: "snooze-first-preset:\(target.id)")
            }
            let snoozeApplied = await UIProbeWait.until {
                model.threads.first(where: { $0.id == target.id })?.snoozedUntil != nil
            }
            if snoozeApplied {
                UIProbeAssertions.pass("sidebar-snooze-applies", "snoozedUntil set on \(target.id)")
            } else {
                UIProbeAssertions.fail(
                    "sidebar-snooze-applies", "snoozedUntil never landed on \(target.id)")
            }

            // 4. The row must leave the active split for the snoozed shelf.
            let reclassified = await UIProbeWait.until {
                guard let group = groupContaining(target.id, multi: multi),
                    case let split = SidebarProjection.groupThreads(group)
                else { return false }
                return !split.active.contains(where: { $0.thread.id == target.id })
                    && split.snoozed.contains(where: { $0.thread.id == target.id })
            }
            if reclassified {
                UIProbeAssertions.pass(
                    "sidebar-snooze-reclassifies", "\(target.id) moved active → snoozed")
            } else {
                UIProbeAssertions.fail(
                    "sidebar-snooze-reclassifies",
                    "\(target.id) never moved to the snoozed split")
            }
            // Let the list finish animating the removal before capturing.
            _ = await UIProbeWait.untilStable { table.numberOfRows }
            snapshot("snooze-3-sidebar", window: window, dir: dir)

            // 5. Reveal the snoozed disclosure so its rows are on screen.
            let rowsBeforeReveal = table.numberOfRows
            NotificationCenter.default.post(name: .uiProbeToggleSection, object: "snoozed")
            let revealed = await UIProbeWait.until { table.numberOfRows > rowsBeforeReveal }
            if revealed {
                UIProbeAssertions.pass("sidebar-snooze-disclosure", "snoozed rows revealed")
            } else {
                UIProbeAssertions.fail(
                    "sidebar-snooze-disclosure", "the snoozed disclosure never opened")
            }
            snapshot("snooze-4-disclosure", window: window, dir: dir)

            // 6. Wake it and it must return to the active split.
            if let thread = model.threads.first(where: { $0.id == target.id }) {
                await model.unsnoozeThread(thread)
            }
            let woke = await UIProbeWait.until {
                guard let group = groupContaining(target.id, multi: multi),
                    case let split = SidebarProjection.groupThreads(group)
                else { return false }
                return split.active.contains(where: { $0.thread.id == target.id })
            }
            if woke {
                UIProbeAssertions.pass("sidebar-snooze-wake", "\(target.id) back in active")
            } else {
                UIProbeAssertions.fail(
                    "sidebar-snooze-wake", "\(target.id) never returned to the active split")
            }
            finish()
        }

        private static func groupContaining(
            _ threadID: String, multi: MultiDeviceModel
        ) -> SidebarProjectGroup? {
            SidebarProjection.projectGroups(in: multi, scope: .all).first { group in
                group.threads.contains { $0.thread.id == threadID }
            }
        }

        // MARK: - Menu driving

        /// Walks rows right-clicking until the target thread's menu reports
        /// itself open, mirroring `SidebarMenuProbe`'s row walk.
        private static func openThreadMenu(
            for threadID: String, table: NSTableView, window: NSWindow
        ) async -> NSWindow? {
            for row in 0..<table.numberOfRows {
                guard let rect = await scrollIntoView(row: row, in: table) else { continue }
                UIProbeMenus.reset()
                let center = NSPoint(x: rect.midX, y: rect.midY)
                postMouse(
                    [.rightMouseDown, .rightMouseUp], in: window,
                    at: table.convert(center, to: nil))
                guard let popover = await waitForPopover() else { continue }
                let opened = await UIProbeWait.until(tries: 10) {
                    UIProbeMenus.opened.contains { $0.hasPrefix("thread:\(threadID):") }
                }
                if opened { return popover }
                await dismissPopover()
            }
            return nil
        }

        /// Finds an accessibility element titled `title` inside `window` and
        /// posts a real click at its frame. Returns whether a frame was found.
        private static func clickElement(titled title: String, in window: NSWindow) async -> Bool {
            guard let frame = accessibilityFrame(titled: title, in: window) else { return false }
            let local = window.convertPoint(fromScreen: NSPoint(x: frame.midX, y: frame.midY))
            postMouse([.leftMouseDown, .leftMouseUp], in: window, at: local)
            return true
        }

        /// Screen-coordinate frame of the first accessibility element whose
        /// title/label matches. Walks views and accessibility children the way
        /// `SidebarMenuProbe.accessibleText` does.
        private static func accessibilityFrame(
            titled title: String, in window: NSWindow
        ) -> NSRect? {
            var visited = Set<ObjectIdentifier>()
            var found: NSRect?

            func matches(_ candidate: String?) -> Bool {
                candidate == title
            }

            func visit(_ object: AnyObject) {
                guard found == nil, visited.insert(ObjectIdentifier(object)).inserted else {
                    return
                }
                if let view = object as? NSView {
                    if matches(view.accessibilityLabel()) || matches(view.accessibilityTitle()) {
                        let frame = view.accessibilityFrame()
                        if !frame.isEmpty {
                            found = frame
                            return
                        }
                    }
                    for subview in view.subviews { visit(subview) }
                    for child in view.accessibilityChildren() ?? [] {
                        if let object = child as? AnyObject { visit(object) }
                    }
                } else if let element = object as? NSAccessibilityElement {
                    if matches(element.accessibilityLabel())
                        || matches(element.accessibilityTitle())
                    {
                        let frame = element.accessibilityFrame()
                        if !frame.isEmpty {
                            found = frame
                            return
                        }
                    }
                    for child in element.accessibilityChildren() ?? [] {
                        if let object = child as? AnyObject { visit(object) }
                    }
                }
            }

            if let root = window.contentView { visit(root) }
            return found
        }

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
            var popover: NSWindow?
            _ = await UIProbeWait.until(tries: 20) {
                popover = popoverWindow()
                return popover != nil
            }
            return popover
        }

        private static func dismissPopover() async {
            guard let popover = popoverWindow() else { return }
            popover.performClose(nil)
            let closed = await UIProbeWait.until(tries: 10) { popoverWindow() == nil }
            if !closed {
                popover.close()
                try? await Task.sleep(for: .milliseconds(200))
            }
        }

        private static func popoverWindow() -> NSWindow? {
            NSApp.windows.first { window in
                window.isVisible
                    && String(describing: type(of: window)).contains("Popover")
            }
        }

        private static func scrollIntoView(row: Int, in table: NSTableView) async -> NSRect? {
            table.scrollRowToVisible(row)
            var rect: NSRect?
            _ = await UIProbeWait.until(tries: 15) {
                let candidate = table.rect(ofRow: row)
                guard !candidate.isEmpty,
                    table.visibleRect.contains(
                        NSPoint(x: candidate.midX, y: candidate.midY))
                else { return false }
                rect = candidate
                return true
            }
            return rect
        }

        private static func snapshot(_ name: String, window: NSWindow, dir: String) {
            guard let view = window.contentView,
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

        private static func finish() {
            _ = UIProbeAssertions.verdict()
            let failures = UIProbeAssertions.failures
            print(
                failures.isEmpty
                    ? "UIProbe: done"
                    : "UIProbe: done FAIL=\(failures.joined(separator: ","))")
            NSApp.terminate(nil)
        }
    }
#endif
