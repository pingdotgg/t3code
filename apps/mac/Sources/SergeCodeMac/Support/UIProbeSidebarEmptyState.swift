#if DEBUG
    import AppKit
    import SwiftUI

    /// `SERGECODE_UI_PROBE_SCENARIO=sidebar-empty-state` — drives a project
    /// section across the empty/non-empty boundary and checks that the list holds
    /// exactly the rows the model says it should on both sides of it.
    ///
    /// This is the boundary the sidebar got wrong: a project with no sessions
    /// rendered a placeholder row, and when threads arrived the row it was
    /// replaced by was inserted *under a running structure animation*. The
    /// placeholder was then left drawn over the rows that took its place — a
    /// second "No sessions" label stranded in the middle of a populated section.
    ///
    /// The check is a row census rather than a bitmap comparison: `numberOfRows`
    /// is what the list actually holds, so a placeholder that outlived its state
    /// shows up as one row more than the model can account for. The captures are
    /// written alongside it for the parts a count cannot see (where the rail
    /// stops, what the header reads).
    @MainActor
    enum SidebarEmptyStateProbe {
        /// Threads added to the empty project, one at a time. More than one so
        /// the placeholder's slot is not merely replaced but pushed down, which
        /// is how it stranded in the first place.
        private static let threadsToAdd = 3

        static func run(multi: MultiDeviceModel, scenery: SceneryStore, dir: String) async {
            try? FileManager.default.createDirectory(
                atPath: dir, withIntermediateDirectories: true)
            UIProbeSidebarState.reset()

            let loaded = await UIProbeWait.until {
                !SidebarProjection.projectGroups(in: multi, scope: .all).isEmpty
            }
            guard loaded else {
                fail("sidebar-empty-load", "no project groups appeared")
                return
            }

            let window = hostSidebar(multi: multi, scenery: scenery)
            defer { window.orderOut(nil) }
            guard let table = await UIProbeSidebar.waitForTable(in: window) else {
                fail("sidebar-empty-load", "sidebar list never realized a row")
                return
            }

            // A project with no sessions is not in the fixture, and it is the
            // whole subject of the scenario, so add one.
            let model = multi.local
            let existing = Set(model.projects.map(\.id))
            await model.addProject(path: "/tmp/sergecode-probe/Empty Project")
            guard let project = await firstProject(in: model, outside: existing) else {
                fail(
                    "sidebar-empty-load",
                    "the added project never reached the model (projects=\(model.projects.count))")
                return
            }
            guard let groupID = await groupID(for: project, in: multi) else {
                fail(
                    "sidebar-empty-load",
                    "project \(project.id) never reached the sidebar projection")
                return
            }
            guard await UIProbeWait.until({ threadCount(of: groupID, in: multi) == 0 }) else {
                fail("sidebar-empty-load", "the added project did not start out empty")
                return
            }

            await settleEntrance()
            await check("sidebar-empty-rows", multi: multi, table: table)
            snapshot("sidebar-empty-state", window: window, dir: dir)

            // Fill it one thread at a time. Each `createThread` lands outside a
            // transaction, exactly as a backend event would, so the structure
            // animation is running while the next one arrives.
            var sawMotion = false
            for index in 1...threadsToAdd {
                async let motion = sampleRowMotion(in: table)
                await model.createThread(
                    projectID: project.id, provider: .claude, title: "Probe task \(index)")
                if await motion { sawMotion = true }
                guard await UIProbeWait.until({ threadCount(of: groupID, in: multi) >= index })
                else {
                    fail("sidebar-empty-fill", "thread \(index) never reached the sidebar")
                    return
                }
            }
            // The stains were a side effect of animating the list's rows, so
            // this is the half of the fix that has to keep holding: rows still
            // *move* when the sidebar re-ranks, rather than snapping.
            if sawMotion {
                UIProbeAssertions.pass("sidebar-structure-animates", "row layers interpolated")
            } else {
                UIProbeAssertions.fail(
                    "sidebar-structure-animates",
                    "rows snapped into place — the structure animation is not reaching them")
            }

            await settleEntrance()
            await check("sidebar-filled-rows", multi: multi, table: table)
            snapshot("sidebar-empty-state-filled", window: window, dir: dir)

            // Churn: one row leaves while another arrives, in the same window.
            // This is the control for the placeholder — if a plain thread row
            // strands here too, the fault is the list's structure animation and
            // not the empty state.
            if let leaving = model.threads.first(where: {
                $0.projectID == project.id && $0.title == "Probe task 1"
            }) {
                async let removal: Void = model.deleteThread(leaving)
                async let arrival = model.createThread(
                    projectID: project.id, provider: .claude, title: "Probe task churn")
                _ = await (removal, arrival)
                _ = await UIProbeWait.until {
                    model.threads.contains {
                        $0.projectID == project.id && $0.title == "Probe task churn"
                    }
                        && !model.threads.contains { $0.id == leaving.id }
                }
                await settleEntrance()
                await check("sidebar-churned-rows", multi: multi, table: table)
                snapshot("sidebar-empty-state-churned", window: window, dir: dir)
            }

            // Then drain it again, one thread at a time. Plain row removals
            // under the same structure animation — the control for the
            // placeholder above, which is a whole branch of the section's
            // content rather than one row of a `ForEach`.
            while let thread = model.threads.first(where: { $0.projectID == project.id }) {
                let remaining = threadCount(of: groupID, in: multi)
                await model.deleteThread(thread)
                guard
                    await UIProbeWait.until({
                        threadCount(of: groupID, in: multi) < remaining
                    })
                else {
                    fail("sidebar-empty-drain", "\(thread.title) never left the sidebar")
                    return
                }
            }

            await settleEntrance()
            await check("sidebar-drained-rows", multi: multi, table: table)
            snapshot("sidebar-empty-state-drained", window: window, dir: dir)
            finish()
        }

        private static func hostSidebar(
            multi: MultiDeviceModel, scenery: SceneryStore
        ) -> NSWindow {
            let frame = NSRect(x: 0, y: 0, width: 340, height: 800)
            let hosting = NSHostingView(rootView: SidebarView(multi: multi, scenery: scenery))
            hosting.frame = frame
            hosting.wantsLayer = true
            hosting.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
            let window = NSWindow(
                contentRect: frame, styleMask: [.titled], backing: .buffered, defer: false)
            DarkAppearanceConfigurator.applyAppearance(to: window)
            window.contentView = hosting
            window.orderFront(nil)
            return window
        }

        // MARK: - Census

        /// What the list holds versus what the model can account for.
        ///
        /// Polled rather than sampled once: the mock keeps mutating threads while
        /// the probe runs, so a single disagreement is as likely to be a count
        /// read mid-update as a real stranded row. Only a disagreement that
        /// survives the poll is reported.
        private static func check(
            _ name: String, multi: MultiDeviceModel, table: NSTableView
        ) async {
            var observed = table.numberOfRows
            var expected = expectedRows(in: multi)
            let agreed = await UIProbeWait.until {
                observed = table.numberOfRows
                expected = expectedRows(in: multi)
                return observed == expected
            }
            print("UIProbe: \(name) rows=\(observed) expected=\(expected)")
            if agreed {
                UIProbeAssertions.pass(name, "\(observed) row(s) accounted for")
            } else {
                UIProbeAssertions.fail(
                    name,
                    "list holds \(observed) rows, model accounts for \(expected)")
            }
        }

        /// The rows `SidebarView` says it renders, from the model alone: one
        /// header per project section, its visible active rows, and the two
        /// affordances that can follow them.
        ///
        /// Mirrors `projectSectionContent`. Nothing here allows for a
        /// placeholder row, because an empty section renders none — if that
        /// changes, this is the check that says so.
        private static func expectedRows(in multi: MultiDeviceModel) -> Int {
            let groups = SidebarProjection.projectGroups(in: multi, scope: .all)
            let revealed = UIProbeSidebarState.revealedSettledGroups
            return groups.reduce(0) { total, group in
                let split = SidebarProjection.groupThreads(group)
                let visible = min(split.active.count, SidebarView.visibleThreadCap)
                let hidden = split.active.count - visible
                return total + 1
                    + visible
                    + (hidden > 0 ? 1 : 0)
                    + (split.settled.isEmpty ? 0 : 1)
                    + (revealed.contains(group.id) ? split.settled.count : 0)
            }
        }

        /// Whether any row is mid-flight: its layer's presentation value differs
        /// from where the layer says it belongs.
        ///
        /// Reading the presentation layer rather than `frame` is the point.
        /// AppKit sets a row view's frame to its destination immediately and
        /// animates the layer towards it, so a frame comparison reports "no
        /// motion" for a list that is visibly sliding. Sampled tightly, because
        /// `Motion.structure` is 240ms and nothing here should wait that out.
        private static func sampleRowMotion(in table: NSTableView, tries: Int = 60) async -> Bool {
            for _ in 0..<tries {
                try? await Task.sleep(for: .milliseconds(8))
                for row in 0..<table.numberOfRows {
                    guard let view = table.rowView(atRow: row, makeIfNecessary: false),
                        let layer = view.layer,
                        let presented = layer.presentation()
                    else { continue }
                    if abs(presented.position.y - layer.position.y) > 0.5
                        || abs(presented.opacity - layer.opacity) > 0.01
                    {
                        return true
                    }
                }
            }
            return false
        }

        private static func threadCount(of groupID: String, in multi: MultiDeviceModel) -> Int {
            SidebarProjection.projectGroups(in: multi, scope: .all)
                .first { $0.id == groupID }?.threads.count ?? 0
        }

        private static func firstProject(
            in model: AppModel, outside existing: Set<String>
        ) async -> Project? {
            var found: Project?
            _ = await UIProbeWait.until {
                found = model.projects.first { !existing.contains($0.id) }
                return found != nil
            }
            return found
        }

        private static func groupID(
            for project: Project, in multi: MultiDeviceModel
        ) async -> String? {
            var found: String?
            _ = await UIProbeWait.until {
                found = SidebarProjection.projectGroups(in: multi, scope: .all)
                    .first { group in
                        group.members.contains { $0.project.id == project.id }
                    }?.id
                return found != nil
            }
            return found
        }

        /// Lets the row entrance finish so a capture is not a half-faded frame.
        /// Derived from the motion policy, like the outline probe's.
        private static func settleEntrance() async {
            let policy = EntrancePolicy(reduceMotion: Motion.reduceMotion)
            let longest =
                policy.delay(forIndex: policy.maxStaggered) + Motion.profile.structureDuration
            try? await Task.sleep(for: .milliseconds(Int(longest * 1000) + 120))
        }

        private static func fail(_ check: String, _ detail: String) {
            UIProbeAssertions.fail(check, detail)
            finish()
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
    }
#endif
