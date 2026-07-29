#if DEBUG
    import AppKit
    import SwiftUI

    /// `SERGECODE_UI_PROBE_SCENARIO=sidebar-outline` — captures the project
    /// outline on its own and checks that its header summaries account for every
    /// session in the group.
    ///
    /// The sidebar is not reachable in the default sweep's window captures: the
    /// shell hides it while the probe drives the detail column, so every PNG the
    /// sweep writes shows chat. This scenario hosts `SidebarView` in a window of
    /// its own — the same trick `snapshotRemoteSidebar` uses — so the outline is
    /// actually on screen when the bitmap is taken.
    ///
    /// The assertion is the part that does not depend on a human reading a PNG.
    /// `SidebarProjectSummary` is what the header renders from, and it is built
    /// by a *different* pass than the ranked split that produces the rows
    /// (deliberately: collapsed sections are never ranked). If those two ever
    /// disagree, a header claims a count its own section does not show, and the
    /// only cheap way to notice is to compare them against the live model.
    ///
    /// Every step waits on a model or table condition rather than on a duration.
    /// The one timed wait left is the entrance animation before a capture, and
    /// it is derived from the motion policy rather than guessed — see
    /// `settleEntrance`.
    @MainActor
    enum SidebarOutlineProbe {
        static func run(multi: MultiDeviceModel, scenery: SceneryStore, dir: String) async {
            try? FileManager.default.createDirectory(
                atPath: dir, withIntermediateDirectories: true)
            // Process-wide state, so the scenario clears it rather than
            // inheriting it. A group left recorded by an earlier run would make
            // the target section look already-open, and the reveal check below
            // would then measure a transition that had already happened.
            UIProbeSidebarState.reset()

            // The mock backend loads asynchronously. Wait for the projection to
            // report projects, not for a duration that assumed it would.
            let loaded = await UIProbeWait.until {
                !SidebarProjection.projectGroups(in: multi, scope: .all).isEmpty
            }
            guard loaded else {
                fail("sidebar-outline-load", "no project groups appeared")
                return
            }

            let window = hostSidebar(multi: multi, scenery: scenery)
            defer { window.orderOut(nil) }
            guard let table = await UIProbeSidebar.waitForTable(in: window) else {
                fail("sidebar-outline-load", "sidebar list never realized a row")
                return
            }

            await settleEntrance()
            checkSummaries(multi: multi)
            snapshot("sidebar-outline", window: window, dir: dir)

            // Settled sessions live behind a per-project disclosure, so the
            // outline's terminating rail and the settled band of the meter only
            // exist once something is settled and the disclosure is open.
            guard let seeded = await seedSettledSession(multi: multi) else {
                fail("sidebar-outline-settled", "could not settle a session")
                return
            }
            if let problem = await revealSettled(seeded, in: multi, table: table) {
                fail("sidebar-outline-settled", problem)
                return
            }

            await settleEntrance()
            checkSummaries(multi: multi)
            snapshot("sidebar-outline-settled", window: window, dir: dir)
            finish()
        }

        private static func hostSidebar(
            multi: MultiDeviceModel, scenery: SceneryStore
        ) -> NSWindow {
            let frame = NSRect(x: 0, y: 0, width: 340, height: 800)
            let hosting = NSHostingView(rootView: SidebarView(multi: multi, scenery: scenery))
            hosting.frame = frame
            // `cacheDisplay` draws the view tree, not the window behind it, and
            // the command bar above the list paints no background of its own —
            // in the shell it sits on the sidebar's material. Without this the
            // whole strip captures as bare white and reads as a rendering bug.
            hosting.wantsLayer = true
            hosting.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
            let window = NSWindow(
                contentRect: frame, styleMask: [.titled], backing: .buffered, defer: false)
            DarkAppearanceConfigurator.applyAppearance(to: window)
            window.contentView = hosting
            window.orderFront(nil)
            return window
        }

        /// Every thread in a group lands in exactly one of the header's four
        /// buckets, and the open/settled split agrees with the ranked one.
        private static func checkSummaries(multi: MultiDeviceModel) {
            let groups = SidebarProjection.projectGroups(in: multi, scope: .all)
            guard !groups.isEmpty else {
                UIProbeAssertions.fail("sidebar-outline-summary", "no project groups")
                return
            }
            var mismatches: [String] = []
            for group in groups {
                let summary = SidebarProjectSummary(group: group)
                let split = SidebarProjection.groupThreads(group)
                print(
                    "UIProbe: project \(group.name) attention=\(summary.attention) "
                        + "running=\(summary.running) idle=\(summary.idle) "
                        + "snoozed=\(summary.snoozed) settled=\(summary.settled) "
                        + "subtitle=\"\(summary.subtitle)\"")
                if summary.total != group.threads.count {
                    mismatches.append(
                        "\(group.name) total=\(summary.total) threads=\(group.threads.count)")
                }
                if summary.open != split.active.count || summary.settled != split.settled.count
                    || summary.snoozed != split.snoozed.count
                {
                    mismatches.append(
                        "\(group.name) split open=\(split.active.count) "
                            + "snoozed=\(split.snoozed.count) "
                            + "settled=\(split.settled.count)")
                }
            }
            if mismatches.isEmpty {
                UIProbeAssertions.pass(
                    "sidebar-outline-summary", "\(groups.count) project(s) accounted for")
            } else {
                UIProbeAssertions.fail(
                    "sidebar-outline-summary", mismatches.joined(separator: "; "))
            }
        }

        /// Settles the first settleable session so the disclosure exists. The
        /// mock fixture seeds none.
        ///
        /// Returns the id of the project section it landed in, which is what the
        /// reveal below asserts on — the settle is the only thing this scenario
        /// knows the state of, so every later expectation is scoped to it rather
        /// than to whatever else the fixture happens to contain. Nil means the
        /// model never reported the thread settled; the write is asynchronous,
        /// so this polls rather than assuming the round trip is done.
        private static func seedSettledSession(multi: MultiDeviceModel) async -> String? {
            let model = multi.local
            guard
                let thread = model.threads.first(where: {
                    $0.status != .archived && ThreadInboxSemantics.canSettle($0)
                        && !ThreadInboxSemantics.effectiveSettled($0)
                })
            else { return nil }
            await model.settleThread(thread)
            let settled = await UIProbeWait.until {
                model.threads.contains {
                    $0.id == thread.id && ThreadInboxSemantics.effectiveSettled($0)
                }
            }
            guard settled else { return nil }
            // Matched on the local device explicitly: a group can span machines,
            // and the same thread id can appear twice when one backend is paired
            // as both the local server and a remote device.
            return SidebarProjection.projectGroups(in: multi, scope: .all)
                .first { group in
                    group.threads.contains {
                        $0.thread.id == thread.id && $0.member.location.id == .local
                    }
                }?.id
        }

        /// Opens the seeded section's settled disclosure and checks that this is
        /// what actually happened. Returns nil on success, or what went wrong.
        ///
        /// Both halves are scoped to `groupID`, and they have to be. Driving the
        /// disclosure with the broadcast key while checking one section lets any
        /// section supply the growth the check is looking for: the target could
        /// render nothing at all and a neighbour opening in the same pass would
        /// carry the row count over the line. So the toggle names the section,
        /// and the assertions are exact rather than "at least" —
        ///
        /// - the revealed set gains *exactly* this section, which is the direct
        ///   test of the disclosure logic and does not depend on the model, and
        /// - the table grows by *exactly* the rows this section was hiding.
        ///
        /// Both row counts are sampled for stability rather than read once.
        /// Settling removes a row from the active list and adds the disclosure
        /// toggle, so a count read straight after the settle is a number in
        /// transit, and the mock keeps mutating threads while the probe runs.
        /// The expected count is re-read from the model after the toggle for the
        /// same reason: it is what the section is hiding *now*, not what it was
        /// hiding before the bracket opened.
        private static func revealSettled(
            _ groupID: String, in multi: MultiDeviceModel, table: NSTableView
        ) async -> String? {
            // The scenario resets the recorded state on entry and `revealedSettled`
            // is `@UIState`, never persisted — so on a fresh run the target is
            // closed. If it is not, the transition this function exists to
            // measure has already happened and the checks below would pass
            // without exercising anything.
            let openBefore = UIProbeSidebarState.revealedSettledGroups
            guard !openBefore.contains(groupID) else {
                return "section \(groupID) was already open before the toggle"
            }
            let rowsBefore = await UIProbeWait.untilStable { table.numberOfRows }

            NotificationCenter.default.post(
                name: .uiProbeToggleSection, object: UIProbeSettledKey.scoped(to: groupID))

            let reported = await UIProbeWait.until {
                UIProbeSidebarState.revealedSettledGroups.contains(groupID)
            }
            let rowsAfter = await UIProbeWait.untilStable { table.numberOfRows }
            let opened = UIProbeSidebarState.revealedSettledGroups.subtracting(openBefore)
            let hidden = settledCount(of: groupID, in: multi)
            print(
                "UIProbe: sidebar-outline settled section=\(groupID) "
                    + "opened=\(opened.sorted()) rows \(rowsBefore)→\(rowsAfter) "
                    + "(hiding \(hidden))")

            guard reported else { return "section \(groupID) never reported its disclosure open" }
            guard opened == [groupID] else {
                return "scoped toggle opened \(opened.sorted()) instead of just \(groupID)"
            }
            guard rowsAfter - rowsBefore == hidden else {
                return "table grew by \(rowsAfter - rowsBefore), expected \(hidden)"
            }
            return nil
        }

        private static func settledCount(of groupID: String, in multi: MultiDeviceModel) -> Int {
            SidebarProjection.projectGroups(in: multi, scope: .all)
                .first { $0.id == groupID }
                .map { SidebarProjectSummary(group: $0).settled } ?? 0
        }

        /// Lets the row entrance finish so a capture is not a half-faded frame.
        ///
        /// Derived from the motion policy rather than picked: the longest a row
        /// can take to arrive is the clamped stagger plus the structure curve, so
        /// this tracks any future change to either instead of going stale.
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
