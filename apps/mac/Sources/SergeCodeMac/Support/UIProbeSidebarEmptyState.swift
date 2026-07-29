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

            // Re-rank the fixture project over and over: a stall promotes a
            // thread into the attention tier and clearing it demotes the thread
            // again, which moves rows without any row arriving or leaving. This
            // is the churn a working session actually produces — sessions start,
            // stall, ask for approval, go quiet — and "threads duplicated in
            // place, worse the longer the app is open" is what a move stranding
            // a row view looks like.
            await shuffleRanking(model: model, multi: multi, table: table)
            snapshot("sidebar-empty-state-reranked", window: window, dir: dir)

            // Settling is the removal a working session performs most: the row
            // leaves the active list and the "Settled" toggle arrives in the
            // same update — one row out, one row in, which is exactly the shape
            // that stranded views.
            await settleAndReopen(model: model, multi: multi, table: table)
            snapshot("sidebar-empty-state-settled", window: window, dir: dir)

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

        /// What the list holds versus what the model can account for, plus any
        /// row view the table is drawing without owning.
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
            var stranded = UIProbeSidebar.strandedRowViews(in: table).count
            let agreed = await UIProbeWait.until {
                observed = table.numberOfRows
                expected = expectedRows(in: multi)
                stranded = UIProbeSidebar.strandedRowViews(in: table).count
                return observed == expected && stranded == 0
            }
            print("UIProbe: \(name) rows=\(observed) expected=\(expected) stranded=\(stranded)")
            if agreed {
                UIProbeAssertions.pass(name, "\(observed) row(s) accounted for, none stranded")
            } else if observed != expected {
                UIProbeAssertions.fail(
                    name,
                    "list holds \(observed) rows, model accounts for \(expected)")
            } else {
                UIProbeAssertions.fail(
                    name,
                    "\(stranded) row view(s) still drawn after the table stopped owning them")
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
            let revealedSnoozed = UIProbeSidebarState.revealedSnoozedGroups
            return groups.reduce(0) { total, group in
                let split = SidebarProjection.groupThreads(group)
                let visible = min(split.active.count, SidebarView.visibleThreadCap)
                let hidden = split.active.count - visible
                return total + 1
                    + visible
                    + (hidden > 0 ? 1 : 0)
                    + (split.snoozed.isEmpty ? 0 : 1)
                    + (revealedSnoozed.contains(group.id) ? split.snoozed.count : 0)
                    + (split.settled.isEmpty ? 0 : 1)
                    + (revealed.contains(group.id) ? split.settled.count : 0)
            }
        }

        /// Settles a session and reopens it, checking after each half that the
        /// table still owns every row view it draws.
        ///
        /// Both directions matter and they are not the same shape: settling
        /// takes a row out of the active list and puts the "Settled" toggle in,
        /// while reopening takes the toggle out and puts the row back.
        private static func settleAndReopen(
            model: AppModel, multi: MultiDeviceModel, table: NSTableView
        ) async {
            guard
                let thread = model.threads.first(where: {
                    $0.status != .archived && ThreadInboxSemantics.canSettle($0)
                        && !ThreadInboxSemantics.effectiveSettled($0)
                })
            else {
                UIProbeAssertions.fail("sidebar-settle", "no settleable session in the fixture")
                return
            }

            await model.settleThread(thread)
            guard
                await UIProbeWait.until({
                    model.threads.contains {
                        $0.id == thread.id && ThreadInboxSemantics.effectiveSettled($0)
                    }
                })
            else {
                UIProbeAssertions.fail("sidebar-settle", "\(thread.title) never settled")
                return
            }
            await settleEntrance()
            let afterSettle = UIProbeSidebar.strandedRowViews(in: table).count

            await model.unsettleThread(thread)
            _ = await UIProbeWait.until {
                model.threads.contains {
                    $0.id == thread.id && !ThreadInboxSemantics.effectiveSettled($0)
                }
            }
            await settleEntrance()
            let afterReopen = UIProbeSidebar.strandedRowViews(in: table).count

            print(
                "UIProbe: sidebar-settle thread=\(thread.id) strandedAfterSettle=\(afterSettle) "
                    + "strandedAfterReopen=\(afterReopen) rows=\(table.numberOfRows) "
                    + "expected=\(expectedRows(in: multi))")
            if afterSettle == 0 && afterReopen == 0 {
                UIProbeAssertions.pass("sidebar-settle", "settle and reopen stranded nothing")
            } else {
                UIProbeAssertions.fail(
                    "sidebar-settle",
                    "settle left \(afterSettle) and reopen left \(afterReopen) "
                        + "row view(s) drawn but unowned")
            }
        }

        /// Rounds of promote/demote churn. Enough that a leak of one row view
        /// per move is unmistakable, few enough to stay inside the watchdog.
        private static let rerankRounds = 8

        /// Promotes and demotes threads in the seeded projects, checking after
        /// every round that the table still owns every row view it draws.
        ///
        /// Reported as one assertion with the worst round attached, rather than
        /// one per round: what matters is whether row views accumulate at all.
        private static func shuffleRanking(
            model: AppModel, multi: MultiDeviceModel, table: NSTableView
        ) async {
            guard let mock = model.backendForShutdown as? MockBackend else {
                print("UIProbe: sidebar-rerank skipped (live backend run)")
                return
            }
            // Threads that are already on screen, so every flip is a move
            // between tiers rather than a row arriving or leaving.
            let targets = model.threads
                .filter { $0.status != .archived && !ThreadInboxSemantics.effectiveSettled($0) }
                .prefix(3)
                .map(\.id)
            guard !targets.isEmpty else {
                UIProbeAssertions.fail("sidebar-rerank", "no rankable threads in the fixture")
                return
            }

            var worst = 0
            var worstRound = 0
            for round in 1...rerankRounds {
                let stalled = round.isMultiple(of: 2)
                for threadID in targets {
                    await mock.probeSetThreadHealth(threadID: threadID, stalled: stalled)
                }
                _ = await UIProbeWait.until(tries: 12) {
                    model.threads.contains { $0.id == targets[0] && $0.isStalled == stalled }
                }
                await settleEntrance()
                let stranded = UIProbeSidebar.strandedRowViews(in: table).count
                if stranded > worst {
                    worst = stranded
                    worstRound = round
                }
            }
            // Leave the fixture as it was found, so the drain below is not
            // reading a state this phase invented.
            for threadID in targets {
                await mock.probeSetThreadHealth(threadID: threadID, stalled: false)
            }
            await settleEntrance()

            let rows = table.numberOfRows
            let expected = expectedRows(in: multi)
            print(
                "UIProbe: sidebar-rerank rounds=\(rerankRounds) rows=\(rows) "
                    + "expected=\(expected) worstStranded=\(worst)")
            if worst == 0 {
                UIProbeAssertions.pass(
                    "sidebar-rerank", "\(rerankRounds) re-rank round(s) stranded nothing")
            } else {
                UIProbeAssertions.fail(
                    "sidebar-rerank",
                    "round \(worstRound) left \(worst) row view(s) drawn but unowned")
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
