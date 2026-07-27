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
    @MainActor
    enum SidebarOutlineProbe {
        static func run(multi: MultiDeviceModel, scenery: SceneryStore, dir: String) async {
            try? FileManager.default.createDirectory(
                atPath: dir, withIntermediateDirectories: true)
            // Let the mock backend's projects and threads land.
            try? await Task.sleep(for: .seconds(2))

            let window = hostSidebar(multi: multi, scenery: scenery)
            defer { window.orderOut(nil) }
            try? await Task.sleep(for: .seconds(1))

            checkSummaries(multi: multi)
            snapshot("sidebar-outline", window: window, dir: dir)

            // Settled sessions live behind a per-project disclosure, so the
            // outline's terminating rail and the settled band of the meter only
            // exist once something is settled and the disclosure is open.
            if await seedSettledSession(multi: multi) {
                NotificationCenter.default.post(
                    name: .uiProbeToggleSection, object: "settled")
                try? await Task.sleep(for: .seconds(1))
                checkSummaries(multi: multi)
                snapshot("sidebar-outline-settled", window: window, dir: dir)
            } else {
                UIProbeAssertions.fail(
                    "sidebar-outline-settled", "could not settle a session")
            }

            _ = UIProbeAssertions.verdict()
            let failures = UIProbeAssertions.failures
            print(
                failures.isEmpty
                    ? "UIProbe: done"
                    : "UIProbe: done FAIL=\(failures.joined(separator: ","))")
            NSApp.terminate(nil)
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
                        + "settled=\(summary.settled) subtitle=\"\(summary.subtitle)\"")
                if summary.total != group.threads.count {
                    mismatches.append(
                        "\(group.name) total=\(summary.total) threads=\(group.threads.count)")
                }
                if summary.open != split.active.count || summary.settled != split.settled.count {
                    mismatches.append(
                        "\(group.name) split open=\(split.active.count) "
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
        private static func seedSettledSession(multi: MultiDeviceModel) async -> Bool {
            let model = multi.local
            guard
                let thread = model.threads.first(where: {
                    $0.status != .archived && ThreadInboxSemantics.canSettle($0)
                        && !ThreadInboxSemantics.effectiveSettled($0)
                })
            else { return false }
            await model.settleThread(thread)
            try? await Task.sleep(for: .milliseconds(500))
            return model.threads.contains {
                $0.id == thread.id && ThreadInboxSemantics.effectiveSettled($0)
            }
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
