#if DEBUG
    import AppKit
    import SwiftUI

    /// Debug-only UI verification hook for agent/CI runs without screen
    /// recording or accessibility permissions: `SERGECODE_UI_PROBE=<dir>`
    /// (typically with `--mock`) selects the first thread, self-captures the
    /// window to PNGs in `<dir>` (in-process bitmap, no TCC prompt), verifies
    /// the optional mock remote sidebar/chat, opens main-area diff review,
    /// logs probe steps to stdout, and quits.
    @MainActor
    enum UIProbe {
        static func runIfRequested(multi: MultiDeviceModel, scenery: SceneryStore) {
            guard let dir = ProcessInfo.processInfo.environment["SERGECODE_UI_PROBE"],
                !dir.isEmpty
            else { return }
            Task { await run(multi: multi, scenery: scenery, dir: dir) }
        }

        /// Compatibility entry point for older probe harnesses.
        static func runIfRequested(model: AppModel, scenery: SceneryStore) {
            guard let dir = ProcessInfo.processInfo.environment["SERGECODE_UI_PROBE"],
                !dir.isEmpty
            else { return }
            let multi = MultiDeviceModel(local: model)
            Task { await run(multi: multi, scenery: scenery, dir: dir) }
        }

        private static func run(multi: MultiDeviceModel, scenery: SceneryStore, dir: String) async {
            let model = multi.local
            try? FileManager.default.createDirectory(
                atPath: dir, withIntermediateDirectories: true)
            switch ProcessInfo.processInfo.environment["SERGECODE_UI_PROBE_SCENARIO"] {
            case "stream-perf":
                await runStreamPerf(model: model, dir: dir)
                return
            case "glass":
                await GlassLayeringProbe.run(multi: multi, scenery: scenery, dir: dir)
                return
            case "tool-group-receive":
                await runToolGroupReceive(model: model, multi: multi, dir: dir)
                return
            default:
                break
            }

            // Let the mock backend load, then select a thread so the
            // inspector has content. Prefer thread-1: it's the one the mock
            // seeds with plan progress, so the plan strip is exercised too.
            try? await Task.sleep(for: .seconds(2))
            if model.selectedThreadID == nil {
                if let threadID = model.threads.first(where: { $0.id == "thread-1" })?.id
                    ?? model.threads.first?.id
                {
                    multi.select(threadID: threadID, on: model.deviceID)
                }
            }
            // Let the inspector timeline present and the diff refresh land.
            try? await Task.sleep(for: .seconds(2))
            snapshot("1-inspector-timeline", dir: dir)
            await probeChatTurnRail(model: model, dir: dir)

            // Unified activity panel: scroll to the checkpoint history, then
            // back up to the changed-files section (legacy section keys).
            toggleSection("activity")
            try? await Task.sleep(for: .seconds(1))
            snapshot("1b-changes-activity", dir: dir)
            toggleSection("files")
            try? await Task.sleep(for: .seconds(0.5))

            // Subagent stability: server-driven stall badge (appears on a
            // synthetic session.health stall, clears on active) and the
            // session.exited stderr disclosure.
            await probeSubagentStability(model: model, multi: multi, dir: dir)

            if let remote = multi.remoteSessions.first {
                await probeRemoteDevice(
                    remote, multi: multi, scenery: scenery, dir: dir)
            }

            // Plan strip above the composer: collapsed rail (it shares the
            // credit row with the Unsplash pill), then expand, snapshot,
            // collapse. The mock seeds plan progress on thread-1, but the
            // rail only mounts while a run is live — start one if needed and
            // hand the thread back idle afterwards. `isLiveTurn` is the same
            // predicate ChatScreen mounts the rail with: a `.backgroundWork`
            // thread is already active, so synthesizing a send there would
            // mutate seeded probe state for no reason.
            let planRunStarted = !(model.selectedThread?.status.isLiveTurn ?? false)
            if planRunStarted {
                // `send` only returns when the mock finishes streaming, so
                // fire it off and snapshot while the turn is still live. The
                // padded text lengthens the canned reply enough that the turn
                // outlives both snapshots (80ms per chunk) — a backstop for
                // the waits below, not the guarantee.
                let filler = String(repeating: "keep the run alive ", count: 40)
                Task { @MainActor in await model.send(text: "Probe: plan rail \(filler)") }
            }
            // Capture the rail in the state it is meant to show: live turn,
            // steps hydrated. The snapshots are gated on that precondition —
            // a PNG written from the wrong state is worse than a missing one,
            // because it looks like evidence.
            let planRailReady = await waitUntil("plan rail is live with steps") {
                guard model.selectedThread?.status.isLiveTurn == true else { return false }
                guard let threadID = model.selectedThreadID else { return false }
                return model.threadState(threadID)?.planProgress?.steps.isEmpty == false
            }
            if planRailReady {
                snapshot("2-plan-rail", dir: dir)
                toggleSection("plan")
                // Re-checked, since a turn that ended between the shots would
                // leave a credit-only row behind.
                let stillLive = await waitUntil("plan rail still live when expanded") {
                    model.selectedThread?.status.isLiveTurn == true
                }
                try? await Task.sleep(for: .seconds(0.5))
                if stillLive {
                    snapshot("2-plan-expanded", dir: dir)
                } else {
                    print("UIProbe: FAIL skipped 2-plan-expanded — turn ended before the capture")
                }
                toggleSection("plan")
                try? await Task.sleep(for: .seconds(0.5))
            } else {
                print(
                    "UIProbe: FAIL skipped 2-plan-rail and 2-plan-expanded — "
                        + "the rail never reached its live+steps state")
            }
            if planRunStarted {
                await model.cancelCurrentTurn()
                _ = await waitUntil("plan thread settled after cancel") {
                    model.selectedThread?.status.isLiveTurn == false
                }
            }

            // Reserved slot: a live turn on a thread the mock never seeds a
            // plan for (thread-2). The strip draws nothing there but holds
            // the rail's height, so the credit pill keeps the exact position
            // it has in `2-plan-rail` above.
            if let planlessThread = model.threads.first(where: { $0.id == "thread-2" }) {
                let restoreThreadID = model.selectedThreadID
                multi.select(threadID: planlessThread.id, on: model.deviceID)
                _ = await waitUntil("planless thread selected") {
                    model.selectedThreadID == planlessThread.id
                }
                let filler = String(repeating: "keep the run alive ", count: 40)
                Task { @MainActor in await model.send(text: "Probe: reserved slot \(filler)") }
                let reservedReady = await waitUntil("planless turn is live without steps") {
                    guard model.selectedThread?.status.isLiveTurn == true else { return false }
                    guard let threadID = model.selectedThreadID else { return false }
                    return model.threadState(threadID)?.planProgress?.steps.isEmpty != false
                }
                if reservedReady {
                    snapshot("2a-plan-row-reserved", dir: dir)
                } else {
                    print(
                        "UIProbe: FAIL skipped 2a-plan-row-reserved — "
                            + "the planless turn never went live")
                }
                await model.cancelCurrentTurn()
                _ = await waitUntil("planless thread settled after cancel") {
                    model.selectedThread?.status.isLiveTurn == false
                }
                if let restoreThreadID {
                    multi.select(threadID: restoreThreadID, on: model.deviceID)
                    _ = await waitUntil("previous thread reselected") {
                        model.selectedThreadID == restoreThreadID
                    }
                }
            }

            // Open main-area review (All Changes) via the timeline harness hook.
            if let threadID = model.selectedThreadID {
                model.openReview(threadID: threadID, scope: .allChanges)
            } else {
                toggleSection("checkpoints")
            }
            try? await Task.sleep(for: .seconds(2))
            snapshot("3-review-all-changes", dir: dir)

            // Checkpoint-scoped review if available.
            if let threadID = model.selectedThreadID,
                let ckpt = model.threadState(threadID)?.checkpoints?.first
            {
                model.openReview(
                    threadID: threadID,
                    scope: .checkpoint(fromTurn: 0, toTurn: ckpt.turnCount, label: ckpt.label)
                )
                try? await Task.sleep(for: .seconds(2))
                snapshot("4-review-checkpoint", dir: dir)
                model.closeReview(threadID: threadID)
                try? await Task.sleep(for: .seconds(1))
            } else {
                model.closeReview()
            }

            // Service tier control: switch to the seeded codex thread, which
            // exposes Standard/Fast choices, then flip the tier and capture.
            let previousThreadID = model.selectedThreadID
            if let codexThread = model.threads.first(where: { $0.id == "thread-2" }) {
                multi.select(threadID: codexThread.id, on: model.deviceID)
                try? await Task.sleep(for: .seconds(1))
                let option = model.models.first {
                    $0.instanceID == codexThread.modelInstanceID
                        && $0.modelID == codexThread.modelID
                }
                let choices = option?.serviceTierChoices.map(\.label) ?? []
                print(
                    "UIProbe: serviceTier choices=\(choices) "
                        + "threadTier=\(model.threads.first { $0.id == codexThread.id }?.serviceTier ?? "nil")")
                if let fast = option?.serviceTierChoices.first(where: { $0.id == "priority" }) {
                    await model.setServiceTier(fast.id)
                    try? await Task.sleep(for: .seconds(1))
                }
                let after = model.threads.first { $0.id == codexThread.id }?.serviceTier
                print("UIProbe: serviceTier after set=\(after ?? "nil")")
                snapshot("4b-service-tier", dir: dir)
                if let previousThreadID {
                    multi.select(threadID: previousThreadID, on: model.deviceID)
                } else {
                    multi.selection = nil
                }
                try? await Task.sleep(for: .seconds(1))
            } else {
                print("UIProbe: no codex thread-2 for service tier probe")
            }

            // Queue while the mock thread is running, then force an idle
            // transition. The first queued message should be removed and sent
            // through the normal send path; any later queued items would wait
            // for the next idle transition.
            let queuedMarker = "Probe queued: send after idle"
            model.enqueueMessage(text: queuedMarker)
            try? await Task.sleep(for: .seconds(1))
            print("UIProbe: queued before idle=\(model.selectedQueuedMessages.count)")
            snapshot("5-queued-message", dir: dir)
            await model.cancelCurrentTurn()
            try? await Task.sleep(for: .seconds(2))
            let autoSent = model.selectedTimeline().contains {
                if case .userMessage(_, let text, _, _) = $0 {
                    return text.contains(queuedMarker)
                }
                return false
            }
            print(
                "UIProbe: queued after idle=\(model.selectedQueuedMessages.count) "
                    + "autoSent=\(autoSent)")
            snapshot("6-queued-autosent", dir: dir)

            // Message actions: Edit stages text that the composer must pick
            // up as its draft (visible in its NSTextView) and consume.
            let marker = "Probe edit: resend me"
            model.stageComposerText(marker)
            try? await Task.sleep(for: .seconds(1))
            let staged = textView(containing: marker) != nil
            print("UIProbe: edit prefill in composer=\(staged) consumed=\(model.composerPrefill == nil)")
            snapshot("7-composer-prefill", dir: dir)

            // Model picker popover: open via the toggle hook and capture every
            // visible window — the popover hosts in its own NSWindow, so the
            // main-window snapshot alone would miss it.
            toggleSection("model-picker")
            try? await Task.sleep(for: .seconds(1))
            snapshotAllWindows("7b-model-picker", dir: dir)
            toggleSection("model-picker")
            try? await Task.sleep(for: .seconds(1))

            // Retry: resending an existing user message appends a new user
            // row to the timeline (mock backend echoes sends).
            let before = userMessageCount(model)
            if let text = firstUserMessageText(model) {
                await model.send(text: text)
            }
            try? await Task.sleep(for: .seconds(1))
            print("UIProbe: retry user rows before=\(before) after=\(userMessageCount(model))")
            snapshot("8-after-retry", dir: dir)

            // Settings ▸ Devices: enable the mobile-access preference so the
            // mock backend reports LAN-reachable and the QR pairing card
            // renders; restore the previous value afterward. Mock runs only:
            // against LiveBackend the sidecar's bind host was fixed at spawn,
            // so flipping the preference here would capture a misleading
            // "restart required" (or loopback) state.
            let isMockRun =
                CommandLine.arguments.contains("--mock")
                || ProcessInfo.processInfo.environment["SERGECODE_MOCK"] == "1"
            if isMockRun {
                let previousMobileAccess = MobileAccessPreference.isEnabled
                let previousTailscaleAccess = TailscaleAccessPreference.isEnabled
                MobileAccessPreference.setEnabled(true)
                TailscaleAccessPreference.setEnabled(true)
                await snapshotSettings(
                    tab: .devices, name: "9-settings-devices", model: model, scenery: scenery,
                    dir: dir)
                await snapshotSettings(
                    tab: .connection, name: "10-settings-connection", model: model,
                    scenery: scenery, dir: dir)
                MobileAccessPreference.setEnabled(previousMobileAccess)
                TailscaleAccessPreference.setEnabled(previousTailscaleAccess)
                await snapshotSettings(
                    tab: .dictation, name: "11-settings-dictation", model: model, scenery: scenery,
                    dir: dir)
                await snapshotSettings(
                    tab: .scenery, name: "12-settings-scenery", model: model, scenery: scenery,
                    dir: dir)
                await snapshotSettings(
                    tab: .general, name: "13-settings-general", model: model, scenery: scenery,
                    dir: dir)
                await snapshotSettings(
                    tab: .providers, name: "14-settings-providers", model: model, scenery: scenery,
                    dir: dir)
                // Archive a seeded thread so the Archive tab captures its
                // search field and thread rows, not just the empty state.
                // thread-2 is safe to borrow: the service-tier step above is
                // its last consumer. Restored right after the capture.
                let borrowedThread = model.threads.first { $0.id == "thread-2" }
                if let borrowedThread {
                    await model.archiveThread(borrowedThread)
                    await model.refreshArchivedThreads()
                }
                await snapshotSettings(
                    tab: .archive, name: "15-settings-archive", model: model, scenery: scenery,
                    dir: dir)
                if let borrowedThread {
                    await model.unarchiveThread(borrowedThread)
                }
                await snapshotSettings(
                    tab: .remoteMacs, name: "16-settings-remote-macs", model: model,
                    scenery: scenery, dir: dir)
                await snapshotSettings(
                    tab: .autoReview, name: "17-settings-auto-review", model: model,
                    scenery: scenery, dir: dir)

                // Window glass translucency: capture solid (1.0) and floor
                // (0.5) states, logging NSWindow isOpaque/clear + behind-window
                // effect presence. Self-capture cannot prove desktop bleed, but
                // it confirms the hierarchy is wired for it.
                await probeWindowTranslucency(scenery: scenery, dir: dir)

                // Brand surfaces: About window + empty state with the
                // BrandMark/BrandWordmark treatment.
                await probeBrand(model: model, scenery: scenery, dir: dir)
            } else {
                print("UIProbe: skipping settings snapshots (live backend run)")
            }

            print(
                "UIProbe: dictation modelStatus=\(model.dictation.modelStatus) "
                    + "cleanupAvailable=\(model.dictation.cleanupAvailable) "
                    + "state=\(model.dictation.state)")

            // Optional dictation E2E: transcribe + clean a wav/aiff on disk
            // through the real pipeline (exercises model download, Parakeet,
            // and Foundation Models cleanup — everything but the mic tap).
            if let audioPath = ProcessInfo.processInfo.environment["SERGECODE_DICTATION_AUDIO"],
                !audioPath.isEmpty
            {
                do {
                    let (raw, cleaned) = try await model.dictation.processAudioFileForProbe(
                        URL(fileURLWithPath: audioPath))
                    print("UIProbe: dictation raw=\(raw)")
                    print("UIProbe: dictation cleaned=\(cleaned)")
                } catch {
                    print("UIProbe: dictation e2e failed: \(error)")
                }
            }

            // Multi-line diff selection: pure builder produces one string with
            // real newlines (SwiftUI Text selection is per-view; the fix joins
            // lines into a single AttributedString).
            let multiLineDiff = FileChangeDiffText.attributedBody([
                (.removed, "let a = 1"),
                (.removed, "let b = 2"),
                (.added, "let a = 2"),
                (.added, "let b = 3"),
            ])
            let multiLinePlain = String(multiLineDiff.characters)
            let multiLineOK =
                multiLinePlain.contains("- let a = 1\n- let b = 2")
                && multiLinePlain.contains("+ let a = 2\n+ let b = 3")
            print(
                "UIProbe: multi-line diff selectable block=\(multiLineOK) "
                    + "chars=\(multiLinePlain.count)")

            // Markdown renderer smoke test: build the real assistant view and
            // verify its AST contains the new GFM block kinds before taking
            // the conversation-wide selection snapshot.
            let markdownProbe = """
            | Name | Status |
            | :--- | ---: |
            | Build | 1 |

            - [ ] pending
            - [x] done

            ```swift
            let answer = 42
            ```
            """
            let markdownBlocks = parseMarkdownBlocks(markdownProbe)
            let tableCount = markdownBlocks.reduce(into: 0) { count, block in
                if case .table = block { count += 1 }
            }
            let taskCount = markdownBlocks.reduce(into: 0) { count, block in
                if case .taskItem = block { count += 1 }
            }
            let codeValues = markdownBlocks.compactMap { block -> String? in
                if case .codeBlock(_, let code) = block { return code }
                return nil
            }
            let highlightedSwift = await CodeHighlighter.shared.highlighted(
                code: codeValues.first ?? "",
                language: "swift",
                dark: false)
            let highlightedColorCount = Set(
                highlightedSwift?.runs.compactMap { run in
                    run.foregroundColor.map { String(describing: $0) }
                } ?? []).count
            let unknownHighlight = await CodeHighlighter.shared.highlighted(
                code: codeValues.first ?? "",
                language: "notareallang",
                dark: false)
            let renderedMarkdown = attributedMarkdownDocument(markdownProbe)
            let markdownHosting = NSHostingView(
                rootView: AssistantMarkdownView(
                    markdown: markdownProbe,
                    isStreaming: false,
                    threadID: model.selectedThreadID ?? "ui-probe",
                    messageID: "ui-probe-markdown",
                    model: model,
                    showsRoleChrome: true))
            markdownHosting.frame = NSRect(x: 0, y: 0, width: 720, height: 360)
            markdownHosting.layoutSubtreeIfNeeded()
            let markdownFittingHeight = markdownHosting.fittingSize.height
            let markdownAccessibleText = accessibleText(in: markdownHosting)
            let markdownTextObserved =
                markdownAccessibleText.contains("Name")
                && markdownAccessibleText.contains("let answer = 42")
            let markdownBitmapObserved =
                !markdownTextObserved && bitmapContainsContent(in: markdownHosting)
            let markdownViewEvidence: String
            if markdownTextObserved {
                markdownViewEvidence = "accessibility:Name+let answer = 42"
            } else if markdownBitmapObserved {
                markdownViewEvidence = "bitmap:non-background-pixels"
            } else {
                markdownViewEvidence = "none"
            }
            let markdownViewOK =
                markdownFittingHeight > 100
                && (markdownTextObserved || markdownBitmapObserved)
            let markdownProbeOK =
                tableCount == 1
                && taskCount == 2
                && codeValues.count == 1
                && highlightedColorCount > 1
                && unknownHighlight == nil
                && String(renderedMarkdown.characters).contains("Name\tStatus")
                && markdownViewOK
            print(
                "UIProbe: markdown table=\(tableCount) tasks=\(taskCount) "
                    + "code=\(codeValues.count) syntaxColors=\(highlightedColorCount) "
                    + "unknownSyntaxNil=\(unknownHighlight == nil) "
                    + "rendered=\(markdownProbeOK) viewHeight=\(markdownFittingHeight) "
                    + "viewEvidence=\(markdownViewEvidence) viewVerified=\(markdownViewOK)")
            assert(markdownProbeOK, "Markdown UI probe failed")

            // Select Text overlay: use the pricing thread (thread-3) — earlier
            // probe steps mutate thread-1's timeline (queue/retry), so a still-
            // seeded conversation is a cleaner fixture for the sheet.
            if let threadID = model.threads.first(where: { $0.id == "thread-3" })?.id
                ?? model.threads.first(where: { $0.id == "thread-1" })?.id
                ?? model.threads.first?.id
            {
                multi.select(threadID: threadID, on: model.deviceID)
            } else {
                multi.selection = nil
            }
            if let threadID = model.selectedThreadID {
                await model.loadTimelineIfNeeded(threadID: threadID)
            }
            try? await Task.sleep(for: .seconds(1))
            let seededCount = model.selectedTimeline().count
            print("UIProbe: select-text prep timelineItems=\(seededCount)")

            toggleSection("select-text")
            try? await Task.sleep(for: .seconds(1.5))
            // Prefer conversation role headers — the composer NSTextView never
            // contains them. Fall back to the longest non-editable text view.
            let selectTextView =
                textView(containing: "Assistant")
                ?? textView(containing: "You\n")
            let candidate =
                selectTextView
                ?? allTextViews()
                    .filter { !$0.isEditable }
                    .max(by: { $0.string.count < $1.string.count })
            if let candidate {
                candidate.selectAll(nil)
                let selected = candidate.selectedRange().length
                let plain = candidate.string
                let preview = String(plain.prefix(120)).replacingOccurrences(of: "\n", with: "\\n")
                let hasConversation =
                    plain.contains("You")
                    || plain.contains("Assistant")
                    || plain.contains("Tool")
                    || plain.contains("Subagent")
                    || plain.contains("Notice")
                print(
                    "UIProbe: select-text open=\(true) hasConversation=\(hasConversation) "
                        + "selectAllLength=\(selected) totalChars=\(plain.count) "
                        + "editable=\(candidate.isEditable) preview=\(preview)")
            } else {
                let all = allTextViews().map {
                    "len=\($0.string.count) editable=\($0.isEditable) "
                        + "preview=\(String($0.string.prefix(40)).replacingOccurrences(of: "\n", with: "\\n"))"
                }
                print(
                    "UIProbe: select-text open failed (no NSTextView) textViews=\(all)")
            }
            snapshotAllWindows("13-select-text", dir: dir)
            toggleSection("select-text-done")
            try? await Task.sleep(for: .seconds(0.5))

            print("UIProbe: done")
            NSApp.terminate(nil)
        }

        /// Exercises the subagent-stability surfaces against the mock backend:
        /// a server `session.health` stall that badges the thread and then
        /// clears on recovery, plus the `session.exited` stderr disclosure row.
        private static func probeSubagentStability(
            model: AppModel, multi: MultiDeviceModel, dir: String
        ) async {
            guard let mock = model.backendForShutdown as? MockBackend else {
                print("UIProbe: subagent-stability skipped (live backend run)")
                return
            }
            guard let threadID = model.selectedThreadID else {
                print("UIProbe: subagent-stability no selected thread")
                return
            }

            // Stall the open thread's turn: subagent task rows + header +
            // sidebar dot flip to the server-driven warning state.
            await mock.probeSetThreadHealth(threadID: threadID, stalled: true)
            try? await Task.sleep(for: .seconds(1))
            let stalledThread = model.threads.first { $0.id == threadID }
            print(
                "UIProbe: stall injected threadStalled=\(stalledThread?.isStalled ?? false)")
            snapshot("2b-thread-stalled", dir: dir)

            // Recovery: server reports activity resumed — the badge clears.
            await mock.probeSetThreadHealth(threadID: threadID, stalled: false)
            try? await Task.sleep(for: .seconds(1))
            let recoveredThread = model.threads.first { $0.id == threadID }
            print(
                "UIProbe: stall cleared threadStalled=\(recoveredThread?.isStalled ?? false)")
            snapshot("2c-agents-active", dir: dir)

            // Provider process death with captured stderr → disclosure row.
            let stderr = """
                Traceback (most recent call last):
                  File \"agent.py\", line 42, in run
                    raise RuntimeError(\"provider process crashed\")
                RuntimeError: provider process crashed
                """
            await mock.probeAppendSessionExit(
                threadID: threadID, summary: "Provider process exited (code 1)",
                stderrTail: stderr)
            try? await Task.sleep(for: .seconds(1))
            let hasSessionExit = model.selectedTimeline().contains {
                if case .sessionExit = $0 { return true }
                return false
            }
            print("UIProbe: session-exit row present=\(hasSessionExit)")
            snapshot("2d-session-stderr", dir: dir)
        }

        /// Every string the main window currently renders (text views plus the
        /// SwiftUI accessibility tree) — enough to assert a view is on screen.
        private static func mainWindowText() -> String {
            guard let window = NSApp.windows.first(where: { $0.isVisible }),
                let root = window.contentView
            else { return "" }
            return accessibleText(in: root)
        }

        private static func runStreamPerf(model: AppModel, dir: String) async {
            // Let MockState publish its seeded threads and ready phase before
            // selecting the same stable fixture used by the regular probe.
            try? await Task.sleep(for: .seconds(2))
            model.selectedThreadID =
                model.threads.first { $0.id == "thread-1" }?.id ?? model.threads.first?.id

            guard let threadID = model.selectedThreadID else {
                print("UIProbe: stream-perf failed: no thread")
                NSApp.terminate(nil)
                return
            }

            PerfMetrics.reset()
            let sendTask = Task { @MainActor in
                await model.send(threadID: threadID, text: "/perf-stream")
            }

            let deadline = Date().addingTimeInterval(60)
            var sawRunning = false
            var reachedIdle = false
            while Date() < deadline {
                let status = model.threads.first { $0.id == threadID }?.status
                if status == .running { sawRunning = true }
                if sawRunning, status == .idle {
                    reachedIdle = true
                    break
                }
                try? await Task.sleep(for: .milliseconds(100))
            }
            let sent = await sendTask.value
            if !reachedIdle, sawRunning == false,
                model.threads.first(where: { $0.id == threadID })?.status == .idle
            {
                reachedIdle = true
            }
            print(
                "UIProbe: stream-perf sent=\(sent) reachedIdle=\(reachedIdle) "
                    + "status=\(String(describing: model.threads.first { $0.id == threadID }?.status))")

            // Give the final AppModel/cache invalidations a turn before the
            // report and screenshot are captured.
            try? await Task.sleep(for: .seconds(1))
            snapshot("perf-final", dir: dir)

            let report = PerfMetrics.report()
            let reportURL = URL(fileURLWithPath: dir).appendingPathComponent("perf-report.txt")
            try? report.write(to: reportURL, atomically: true, encoding: .utf8)
            print(report)
            print("UIProbe: stream-perf done")
            NSApp.terminate(nil)
        }

        /// Window-relative band (bottom-left origin, points) covering the last
        /// collapsed tool group in the default 1653x720 probe window. Fixed
        /// rather than measured: the probe drives a fixed fixture, so the row
        /// lands in the same place every run.
        private static let toolGroupBand = NSRect(x: 400, y: 195, width: 900, height: 170)

        /// Drives a live tool burst past `liveAutoCollapseToolThreshold` so the
        /// mid-turn collapse kicks in, then feeds one more finished tool and
        /// captures the collapsed group across the receive flight.
        ///
        /// The flight is a `KeyframeAnimator`, which re-evaluates the SwiftUI
        /// body at each interpolated value rather than handing a CoreAnimation
        /// layer to the render server — so an in-process `cacheDisplay` really
        /// does capture the deck mid-open instead of snapping to the end state.
        private static func runToolGroupReceive(
            model: AppModel, multi: MultiDeviceModel, dir: String
        ) async {
            try? await Task.sleep(for: .seconds(2))
            guard let mock = model.backendForShutdown as? MockBackend else {
                print("UIProbe: tool-group-receive skipped (live backend run)")
                NSApp.terminate(nil)
                return
            }
            guard
                let threadID = model.threads.first(where: { $0.id == "thread-1" })?.id
                    ?? model.threads.first?.id
            else {
                print("UIProbe: tool-group-receive failed: no thread")
                NSApp.terminate(nil)
                return
            }
            multi.select(threadID: threadID, on: model.deviceID)
            try? await Task.sleep(for: .seconds(2))

            let burst: [(String, String, ToolEventKind)] = [
                ("read_file", "Sources/App/Model.swift", .fileRead),
                ("run_command", "swift build", .command),
                ("edit_file", "Sources/App/View.swift", .fileChange),
                ("read_file", "Sources/App/Theme.swift", .fileRead),
                ("web_search", "swiftui keyframe animator", .webSearch),
                ("run_command", "swift test", .command),
                ("edit_file", "Sources/App/Row.swift", .fileChange),
                ("mcp_call", "linear.issue", .mcpCall),
                ("read_file", "Package.swift", .fileRead),
            ]
            for (name, detail, kind) in burst {
                await mock.probeAppendRunningToolEvent(
                    threadID: threadID, name: name, detail: detail, kind: kind)
                try? await Task.sleep(for: .milliseconds(120))
            }
            try? await Task.sleep(for: .seconds(1))
            print("UIProbe: tool-group-receive \(describeToolGroup(model: model, threadID: threadID))")
            snapshot("tg-0-collapsed-at-rest", dir: dir)

            // One more finished tool: the row below vanishes into the summary,
            // and the deck should fan open to take its chip in. Captured
            // back-to-back and named by measured elapsed time — a window
            // `cacheDisplay` costs enough that a fixed sleep cadence samples
            // the flight far later than it claims to.
            let started = Date()
            await mock.probeAppendRunningToolEvent(
                threadID: threadID, name: "run_command", detail: "swift build --package-path apps/mac",
                kind: .command)
            for index in 0..<24 {
                let elapsed = Int(Date().timeIntervalSince(started) * 1000)
                snapshotRegion(
                    "tg-frame-\(String(format: "%02d", index))-\(elapsed)ms",
                    rect: Self.toolGroupBand, dir: dir)
                try? await Task.sleep(for: .milliseconds(16))
            }
            print("UIProbe: tool-group-receive \(describeToolGroup(model: model, threadID: threadID))")
            print("UIProbe: tool-group-receive done")
            NSApp.terminate(nil)
        }

        /// Shape of the selected thread's display rows, for the probe log:
        /// how many rows render, and the collapsed group's headline count.
        private static func describeToolGroup(model: AppModel, threadID: String) -> String {
            let settled = model.thread(threadID: threadID)?.status.isSettled ?? false
            let display = model.timeline(threadID: threadID)
                .groupedForDisplay(threadIsSettled: settled, includeSeparators: false)
            let groups = display.compactMap { item -> Int? in
                guard case .toolGroup(_, _, let summary) = item else { return nil }
                return summary.toolCount
            }
            let liveRows = display.count { item in
                guard case .single(let single) = item, case .toolEvent = single else { return false }
                return true
            }
            return "rows=\(display.count) groupToolCounts=\(groups) liveToolRows=\(liveRows)"
        }

        private static func probeRemoteDevice(
            _ session: RemoteDeviceSession,
            multi: MultiDeviceModel,
            scenery: SceneryStore,
            dir: String
        ) async {
            let previousSelection = multi.selection
            defer { multi.selection = previousSelection }

            // The mock remote briefly reconnects after startup. Wait for its
            // ready state so the probe captures the enabled remote rows as
            // well as the status-dot transition.
            for _ in 0..<12 {
                if case .ready = session.connection { break }
                try? await Task.sleep(for: .milliseconds(250))
            }
            await snapshotRemoteSidebar(
                multi: multi, scenery: scenery, dir: dir)

            guard let thread = session.model.threads.first(where: { $0.status != .archived }) else {
                print("UIProbe: remote session has no selectable thread")
                return
            }
            multi.select(threadID: thread.id, on: session.id)
            await session.model.loadTimelineIfNeeded(threadID: thread.id)
            try? await Task.sleep(for: .seconds(2))
            snapshot("remote-chat-inspector", dir: dir)
            print(
                "UIProbe: remote device=\(session.descriptor.name) "
                    + "projectCount=\(session.model.projects.count) "
                    + "thread=\(thread.id) phase=\(session.connection)")
        }

        private static func snapshotRemoteSidebar(
            multi: MultiDeviceModel,
            scenery: SceneryStore,
            dir: String
        ) async {
            let hosting = NSHostingView(
                rootView: SidebarView(multi: multi, scenery: scenery))
            hosting.frame = NSRect(x: 0, y: 0, width: 340, height: 760)
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 340, height: 760),
                styleMask: [.titled], backing: .buffered, defer: false)
            DarkAppearanceConfigurator.applyAppearance(to: window)
            window.contentView = hosting
            window.orderFront(nil)
            try? await Task.sleep(for: .seconds(1))
            print(
                "UIProbe: remote sidebar device=\(multi.remoteSessions.map { $0.descriptor.name }) "
                    + "projects=\(multi.remoteSessions.flatMap { $0.model.projects.map(\.name) })")
            snapshot("remote-sidebar", window: window, dir: dir)
            window.orderOut(nil)
        }

        /// Logs how many turns the leading-edge chat turn rail renders for
        /// the selected thread, then captures the window so the rail is
        /// visible in the PNG. The rail is pure SwiftUI overlay chrome, so a
        /// plain window snapshot is the whole verification.
        private static func probeChatTurnRail(model: AppModel, dir: String) async {
            guard let threadID = model.selectedThreadID else {
                print("UIProbe: turn rail probe failed (no selected thread)")
                return
            }
            let items = model.timeline(threadID: threadID)
            let settled = model.thread(threadID: threadID)?.status.isSettled ?? false
            let turns = ChatTurnRailModel.turns(
                from: items.groupedForDisplay(threadIsSettled: settled))
            print(
                "UIProbe: turn rail turns=\(turns.count) "
                    + "visible=\(turns.count >= 2)")
            snapshot("1c-chat-turn-rail", dir: dir)
        }

        /// Captures the main window at translucency 1.0 and 0.5 and logs
        /// window/glass configuration for verification.
        private static func probeWindowTranslucency(scenery: SceneryStore, dir: String) async {
            let previous = scenery.sceneryTranslucency

            scenery.setSceneryTranslucency(1.0)
            try? await Task.sleep(for: .seconds(1))
            logWindowGlassState(label: "translucency=1.0")
            snapshot("13-glass-opaque", dir: dir)

            scenery.setSceneryTranslucency(0.5)
            try? await Task.sleep(for: .seconds(1))
            logWindowGlassState(label: "translucency=0.5")
            snapshot("14-glass-see-through", dir: dir)

            scenery.setSceneryTranslucency(previous)
            scenery.flushPendingSettingsSave()
            try? await Task.sleep(for: .milliseconds(200))
        }

        private static func logWindowGlassState(label: String) {
            guard let window = NSApp.windows.first(where: {
                $0.isVisible && $0.styleMask.contains(.titled) && $0.styleMask.contains(.resizable)
            }) else {
                print("UIProbe: \(label) no main window")
                return
            }
            let opaque = window.isOpaque
            let clearBG = window.backgroundColor == .clear
            let configured = TransparentWindowConfigurator.isConfigured(window)
            let behindCount = TransparentWindowConfigurator.behindWindowEffectCount(
                in: window.contentView)
            print(
                "UIProbe: \(label) isOpaque=\(opaque) clearBackground=\(clearBG) "
                    + "appearance=\(window.appearance?.name.rawValue ?? "nil") "
                    + "effectiveAppearance=\(window.effectiveAppearance.name.rawValue) "
                    + "configured=\(configured) behindWindowEffects=\(behindCount)")
            if !configured {
                print("UIProbe: FAIL expected non-opaque clear window for glass translucency")
            } else if behindCount == 0 {
                print("UIProbe: FAIL expected ≥1 behind-window NSVisualEffectView")
            } else {
                print("UIProbe: PASS window glass hierarchy ready (\(label))")
            }
        }

        /// Hosts AboutView and EmptyStateView in throwaway windows and
        /// captures them — the About window and no-selection empty state
        /// can't be reached once the probe has selected a thread, and this
        /// exercises the identical view trees.
        private static func probeBrand(model: AppModel, scenery: SceneryStore, dir: String) async {
            let aboutHosting = NSHostingView(rootView: AboutView())
            let aboutWindow = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 380, height: 460),
                styleMask: [.titled], backing: .buffered, defer: false)
            DarkAppearanceConfigurator.applyAppearance(to: aboutWindow)
            aboutWindow.contentView = aboutHosting
            aboutWindow.orderFront(nil)
            try? await Task.sleep(for: .seconds(2))
            if let view = aboutWindow.contentView,
                let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds)
            {
                view.cacheDisplay(in: view.bounds, to: rep)
                if let data = rep.representation(using: .png, properties: [:]) {
                    let url = URL(fileURLWithPath: dir).appendingPathComponent("16-about.png")
                    try? data.write(to: url)
                    print("UIProbe: wrote \(url.path)")
                }
            }
            aboutWindow.orderOut(nil)

            let emptyHosting = NSHostingView(
                rootView: EmptyStateView(
                    scenery: scenery, onQuickChat: {}, onNewSession: {}))
            let emptyWindow = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 900, height: 600),
                styleMask: [.titled], backing: .buffered, defer: false)
            DarkAppearanceConfigurator.applyAppearance(to: emptyWindow)
            emptyWindow.contentView = emptyHosting
            emptyWindow.orderFront(nil)
            try? await Task.sleep(for: .seconds(2))
            if let view = emptyWindow.contentView,
                let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds)
            {
                view.cacheDisplay(in: view.bounds, to: rep)
                if let data = rep.representation(using: .png, properties: [:]) {
                    let url = URL(fileURLWithPath: dir).appendingPathComponent("17-empty-state.png")
                    try? data.write(to: url)
                    print("UIProbe: wrote \(url.path)")
                }
            }
            emptyWindow.orderOut(nil)
            print("UIProbe: brand about+empty snapshots captured")
        }

        /// Hosts SettingsScene in its own window on `tab` and captures it —
        /// the real Settings scene can't be opened programmatically without
        /// the menu, and this exercises the identical view tree.
        private static func snapshotSettings(
            tab: SettingsTab, name: String, model: AppModel, scenery: SceneryStore, dir: String
        ) async {
            let hosting = NSHostingView(
                rootView: SettingsScene(
                    model: model,
                    scenery: scenery,
                    initialTab: tab))
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 780, height: 560),
                styleMask: [.titled], backing: .buffered, defer: false)
            DarkAppearanceConfigurator.applyAppearance(to: window)
            window.contentView = hosting
            window.orderFront(nil)
            // Let async .task loads (reachability check, pairing mint) land.
            try? await Task.sleep(for: .seconds(2))
            if let view = window.contentView,
                let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds)
            {
                view.cacheDisplay(in: view.bounds, to: rep)
                if let data = rep.representation(using: .png, properties: [:]) {
                    let url = URL(fileURLWithPath: dir).appendingPathComponent("\(name).png")
                    try? data.write(to: url)
                    print("UIProbe: wrote \(url.path)")
                }
            }
            window.orderOut(nil)
        }

        /// Toggles a collapsible section via the probe notification hook
        /// (see UIProbeHooks.swift) — SwiftUI's AX tree doesn't resolve for
        /// same-process clients, so buttons can't be pressed through AX here.
        private static func toggleSection(_ key: String) {
            NotificationCenter.default.post(name: .uiProbeToggleSection, object: key)
            print("UIProbe: toggled section '\(key)'")
        }

        /// Polls `condition` until it holds, then returns true. A fixed sleep
        /// snapshots whatever the app happens to be doing at that instant —
        /// this makes the intended state a precondition of the capture and
        /// prints a FAIL line (rather than silently shooting the wrong frame)
        /// when it never arrives.
        private static func waitUntil(
            _ label: String,
            timeout: Duration = .seconds(8),
            _ condition: @MainActor () -> Bool
        ) async -> Bool {
            let step = Duration.milliseconds(50)
            var waited = Duration.zero
            while waited < timeout {
                if condition() {
                    print("UIProbe: PASS \(label) after \(waited)")
                    return true
                }
                try? await Task.sleep(for: step)
                waited += step
            }
            print("UIProbe: FAIL \(label) still false after \(timeout)")
            return false
        }

        private static func userMessageCount(_ model: AppModel) -> Int {
            model.selectedTimeline().count {
                if case .userMessage = $0 { return true } else { return false }
            }
        }

        private static func firstUserMessageText(_ model: AppModel) -> String? {
            for item in model.selectedTimeline() {
                if case .userMessage(_, let text, _, _) = item { return text }
            }
            return nil
        }

        private static func textView(containing needle: String) -> NSTextView? {
            allTextViews().first { $0.string.contains(needle) }
        }

        private static func allTextViews() -> [NSTextView] {
            var found: [NSTextView] = []
            for window in NSApp.windows where window.isVisible {
                if let root = window.contentView {
                    found += textViews(in: root)
                }
            }
            return found
        }

        private static func textViews(in view: NSView) -> [NSTextView] {
            var found: [NSTextView] = []
            if let text = view as? NSTextView { found.append(text) }
            for subview in view.subviews {
                found += textViews(in: subview)
            }
            return found
        }

        /// SwiftUI's hosting view may expose Text through native text views,
        /// accessibility elements, or neither in a headless probe. Try the
        /// first two before falling back to the bitmap assertion below.
        private static func accessibleText(in root: NSView) -> String {
            var values: [String] = []
            var visited = Set<ObjectIdentifier>()

            func append(_ value: String?) {
                guard let value, !value.isEmpty else { return }
                values.append(value)
            }

            func visit(_ object: AnyObject) {
                guard visited.insert(ObjectIdentifier(object)).inserted else { return }

                if let view = object as? NSView {
                    if let textView = view as? NSTextView { append(textView.string) }
                    if let textField = view as? NSTextField { append(textField.stringValue) }
                    append(view.accessibilityTitle())
                    append(view.accessibilityValue() as? String)

                    for subview in view.subviews {
                        visit(subview)
                    }
                    for child in view.accessibilityChildren() ?? [] {
                        if let childView = child as? NSView {
                            visit(childView)
                        } else if let childElement = child as? NSAccessibilityElement {
                            visit(childElement)
                        }
                    }
                } else if let element = object as? NSAccessibilityElement {
                    append(element.accessibilityTitle())
                    append(element.accessibilityValue() as? String)
                    for child in element.accessibilityChildren() ?? [] {
                        if let childView = child as? NSView {
                            visit(childView)
                        } else if let childElement = child as? NSAccessibilityElement {
                            visit(childElement)
                        }
                    }
                }
            }

            visit(root)
            return values.joined(separator: "\n")
        }

        /// Render the hosted view into a bitmap when SwiftUI does not expose
        /// text through its headless accessibility/subview tree. Compare
        /// sampled pixels with the empty bottom-right background and require
        /// at least one percent of the view to contain visible content.
        private static func bitmapContainsContent(in view: NSView) -> Bool {
            guard !view.bounds.isEmpty,
                let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds),
                rep.pixelsWide > 0,
                rep.pixelsHigh > 0
            else { return false }

            view.cacheDisplay(in: view.bounds, to: rep)
            guard let background = rep.colorAt(x: rep.pixelsWide - 1, y: rep.pixelsHigh - 1),
                let backgroundRGB = background.usingColorSpace(.deviceRGB)
            else { return false }

            let stride = max(1, min(rep.pixelsWide, rep.pixelsHigh) / 180)
            var sampledPixels = 0
            var contentPixels = 0
            for y in Swift.stride(from: 0, to: rep.pixelsHigh, by: stride) {
                for x in Swift.stride(from: 0, to: rep.pixelsWide, by: stride) {
                    guard let color = rep.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB)
                    else { continue }
                    sampledPixels += 1
                    let distance = max(
                        abs(color.redComponent - backgroundRGB.redComponent),
                        abs(color.greenComponent - backgroundRGB.greenComponent),
                        abs(color.blueComponent - backgroundRGB.blueComponent),
                        abs(color.alphaComponent - backgroundRGB.alphaComponent))
                    if distance > 0.08 { contentPixels += 1 }
                }
            }

            return sampledPixels > 0
                && Double(contentPixels) / Double(sampledPixels) > 0.01
        }

        private static func snapshotAllWindows(_ name: String, dir: String) {
            let visible = NSApp.windows.filter(\.isVisible)
            print("UIProbe: \(name) visible windows=\(visible.count)")
            for (index, window) in visible.enumerated() {
                snapshot("\(name)-w\(index)", window: window, dir: dir)
            }
        }

        private static func snapshot(_ name: String, dir: String) {
            guard let window = NSApp.windows.first(where: { $0.isVisible }) else {
                print("UIProbe: snapshot \(name) failed (no window)")
                return
            }
            snapshot(name, window: window, dir: dir)
        }

        /// Captures just `rect` of the main window (view coordinates, so the
        /// origin is bottom-left). A full-window `cacheDisplay` costs ~230 ms,
        /// which is more than a whole transition lasts; a narrow band is cheap
        /// enough to sample an animation frame by frame.
        private static func snapshotRegion(_ name: String, rect: NSRect, dir: String) {
            guard let window = NSApp.windows.first(where: { $0.isVisible }),
                let view = window.contentView?.superview ?? window.contentView,
                let rep = view.bitmapImageRepForCachingDisplay(in: rect)
            else {
                print("UIProbe: region snapshot \(name) failed (no window)")
                return
            }
            view.cacheDisplay(in: rect, to: rep)
            guard let data = rep.representation(using: .png, properties: [:]) else { return }
            let url = URL(fileURLWithPath: dir).appendingPathComponent("\(name).png")
            try? data.write(to: url)
        }

        private static func snapshot(_ name: String, window: NSWindow, dir: String) {
            // Capture the theme frame (contentView's superview) so the window
            // toolbar chrome is included, not just the content area.
            guard let view = window.contentView?.superview ?? window.contentView,
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
