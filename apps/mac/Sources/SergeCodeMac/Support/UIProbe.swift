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
            case "window-size":
                await runWindowSize(multi: multi, dir: dir)
                return
            case "min-size":
                await runMinSize(multi: multi, scenery: scenery)
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
            await probeCommandTaskCard(model: model, dir: dir)

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

        /// Command tasks render as shell work, not as delegated agents, and a
        /// foreground command renders no task card at all (its tool row is the
        /// whole story). The card only appears mid-transcript, so host it
        /// directly instead of scrolling the chat to it.
        private static func probeCommandTaskCard(model: AppModel, dir: String) async {
            let threadID = model.selectedThreadID
            let items = threadID.map { model.timeline(threadID: $0) } ?? []
            let commandCards = items.filter {
                if case .subagentTask(let task) = $0 { return task.entityKind == .command }
                return false
            }
            let foregroundCards = commandCards.filter {
                if case .subagentTask(let task) = $0 { return !task.isBackgrounded }
                return false
            }
            print(
                "UIProbe: command task cards=\(commandCards.count) "
                    + "foreground=\(foregroundCards.count)")

            let now = Date()
            let running = SubagentTaskItem(
                taskId: "probe-command-running", taskType: "local_bash",
                entityKind: .command, description: "Run full mac test suite",
                state: .running, latestProgress: nil, lastToolName: "local_bash",
                isBackgrounded: true, startedAt: now.addingTimeInterval(-190),
                lastActivityAt: now.addingTimeInterval(-4), duration: nil,
                progressLog: [
                    SubagentTaskProgressEntry(
                        at: now.addingTimeInterval(-120), toolName: "local_bash",
                        text: "Building for debugging..."),
                    SubagentTaskProgressEntry(
                        at: now.addingTimeInterval(-4), toolName: "local_bash",
                        text: "Test Suite 'SubagentTaskPresentationTests' started\n"
                            + "✔ subtitle prefers the completion summary (0.004s)"),
                ])
            var finished = running
            finished.taskId = "probe-command-finished"
            finished.description = "Tail deploy logs"
            finished.state = .completed
            finished.duration = 214
            finished.lastActivityAt = now.addingTimeInterval(-30)

            // Defensive shape: a command row that somehow arrives without the
            // detach flag must not claim to be backgrounded.
            var attached = running
            attached.taskId = "probe-command-attached"
            attached.description = "Compile the sidecar"
            attached.isBackgrounded = false

            // Settled with a summary but no streamed output: the completion
            // summary is the whole account of the run, so it must be on the
            // card rather than collapsed to "Finished".
            var summarized = running
            summarized.taskId = "probe-command-summarized"
            summarized.description = "Sync the release notes"
            summarized.state = .completed
            summarized.duration = 47
            summarized.progressLog = []
            summarized.latestProgress = "Process exited with code 0."

            // A failure with no streamed output: the error must be readable on
            // the card rather than hidden behind a chevron that expands nothing.
            var failed = running
            failed.taskId = "probe-command-failed"
            failed.description = "Publish the appcast"
            failed.state = .failed
            failed.duration = 12
            failed.progressLog = []
            failed.error = "exited with code 1\nsee /tmp/appcast.log for the full output"

            let hosting = NSHostingView(
                rootView: VStack(alignment: .leading, spacing: 12) {
                    CommandTaskCard(
                        task: running, stopError: nil, onStop: {}, onClearStopError: {})
                    CommandTaskCard(
                        task: finished, stopError: nil, onStop: {}, onClearStopError: {})
                    CommandTaskCard(
                        task: attached, stopError: nil, onStop: {}, onClearStopError: {})
                    CommandTaskCard(
                        task: summarized, stopError: nil, onStop: {}, onClearStopError: {})
                    CommandTaskCard(
                        task: failed, stopError: nil, onStop: {}, onClearStopError: {})
                }
                .padding(16))
            let frame = NSRect(x: 0, y: 0, width: 720, height: 860)
            hosting.frame = frame
            let window = NSWindow(
                contentRect: frame, styleMask: [.titled], backing: .buffered, defer: false)
            DarkAppearanceConfigurator.applyAppearance(to: window)
            window.contentView = hosting
            window.orderFront(nil)
            try? await Task.sleep(for: .seconds(1))
            snapshot("1d-command-task-cards", window: window, dir: dir)
            window.orderOut(nil)
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

        /// Window-sizing diagnostic: shrinks the window below the split-view
        /// content minimum, then exercises the structural toggles (inspector,
        /// sidebar, thread selection, main-area review) logging the window
        /// frame and AppKit minimum after each step. Any step that reports a
        /// larger frame than the previous one grew the window behind the
        /// user's back.
        private static func runWindowSize(multi: MultiDeviceModel, dir: String) async {
            let model = multi.local
            try? await Task.sleep(for: .seconds(2))
            guard let window = NSApp.windows.first(where: { $0.isVisible }) else {
                print("UIProbe: window-size failed (no window)")
                NSApp.terminate(nil)
                return
            }
            // A window whose maximum has become finite is capped, whatever the
            // number. Checked at every step below rather than once, so a cap
            // that only appears after a particular resize, toggle, or content
            // change cannot slip through: the clamp answers the unbounded probe
            // with `.infinity`, and this is what holds it to that.
            var maximumWentFinite = false
            func assertUnboundedMaximum(_ tag: String) {
                let maximum = window.contentMaxSize
                guard maximum.width < 10000 || maximum.height < 10000 else { return }
                maximumWentFinite = true
                UIProbeAssertions.fail(
                    "max-size",
                    "contentMaxSize went finite at \(tag): "
                        + "\(Int(maximum.width))x\(Int(maximum.height))")
            }

            func log(_ tag: String) {
                let f = window.frame
                print(
                    "UIProbe: window-size \(tag) "
                        + "frame=\(Int(f.width))x\(Int(f.height)) "
                        + "content=\(Int(window.contentLayoutRect.width))x\(Int(window.contentLayoutRect.height)) "
                        + "minSize=\(Int(window.minSize.width))x\(Int(window.minSize.height)) "
                        + "contentMinSize=\(Int(window.contentMinSize.width))x\(Int(window.contentMinSize.height)) "
                        + "contentMaxSize=\(Int(min(window.contentMaxSize.width, 99999)))x"
                        + "\(Int(min(window.contentMaxSize.height, 99999))) "
                        + "autosave='\(window.frameAutosaveName)' restorable=\(window.isRestorable)")
                assertUnboundedMaximum(tag)
            }
            log("initial")
            logSplitViews(window)

            window.setContentSize(NSSize(width: 1500, height: 700))
            try? await Task.sleep(for: .seconds(1.5))
            log("after-grow-1500")
            if model.selectedThreadID == nil,
                let threadID = model.threads.first(where: { $0.id == "thread-1" })?.id
                    ?? model.threads.first?.id
            {
                multi.select(threadID: threadID, on: model.deviceID)
                try? await Task.sleep(for: .seconds(2))
            }
            snapshot("window-size-wide", window: window, dir: dir)

            // Stepwise shrink: a user drags the corner, so the minimum is
            // re-evaluated at every intermediate width.
            for target in stride(from: 1450, through: 800, by: -50) {
                window.setContentSize(NSSize(width: CGFloat(target), height: 600))
                try? await Task.sleep(for: .seconds(0.4))
                log("after-shrink-\(target)")
            }

            log("after-select-thread")

            toggleSection("inspector")
            try? await Task.sleep(for: .seconds(1.5))
            log("after-inspector-hide")

            toggleSection("inspector")
            try? await Task.sleep(for: .seconds(1.5))
            log("after-inspector-show")

            toggleSection("sidebar")
            try? await Task.sleep(for: .seconds(1.5))
            log("after-sidebar-hide")

            toggleSection("sidebar")
            try? await Task.sleep(for: .seconds(1.5))
            log("after-sidebar-show")

            if let threadID = model.selectedThreadID {
                model.openReview(threadID: threadID, scope: .allChanges)
                try? await Task.sleep(for: .seconds(2))
                log("after-open-review")
                model.closeReview(threadID: threadID)
                try? await Task.sleep(for: .seconds(1.5))
                log("after-close-review")
            }

            await probeGitStripAnchor(multi: multi, dir: dir, window: window)
            await probeHeaderFloorCoversWidestState(multi: multi)
            await probeLateVcsStatusAnchor(multi: multi, dir: dir)
            await probeContentGrowthDoesNotResizeWindow(
                multi: multi, dir: dir, window: window, log: log)

            snapshot("window-size-final", window: window, dir: dir)
            // The checks above assert product behavior, not diagnostics: a
            // window that resized itself or a strip that lost its anchor has to
            // fail the run, not just print. `exit` rather than
            // `NSApp.terminate` because the terminate path always reports
            // success, and a caller watching the status would read a broken
            // clamp as green.
            assertUnboundedMaximum("end-of-run")
            if !maximumWentFinite {
                UIProbeAssertions.pass(
                    "max-size", "contentMaxSize stayed unbounded across every step")
            }

            let status = UIProbeAssertions.verdict()
            fflush(stdout)
            guard status == 0 else { exit(status) }
            NSApp.terminate(nil)
        }

        /// The regression this whole change exists to prevent: repository state
        /// growing the git strip must not move the window. Shrinks the window
        /// to its minimum, then injects a deliberately oversized VCS status (a
        /// very long branch name, five-figure diff counts, a draft PR with
        /// conflicts and review comments) and checks the frame, the AppKit
        /// minimum, and the AppKit maximum against the values from before.
        /// Holds `WindowSizing.minContentWidth` to account: the floor is a
        /// fixed number, so it has to keep covering the header's *incompressible*
        /// width — the provider badge, the status badge, and the title's minimum
        /// — across every status label and repository state. The git strip
        /// itself scrolls, so it does not participate; what would break is the
        /// fixed chrome around it being clipped at the window minimum, which no
        /// amount of scrolling recovers.
        ///
        /// Measured rather than assumed, because status labels are the widest
        /// piece and they change with the wording (and would change again with
        /// localisation).
        private static func probeHeaderFloorCoversWidestState(
            multi: MultiDeviceModel
        ) async {
            let model = multi.local
            guard let thread = model.selectedThread ?? model.threads.first else {
                UIProbeAssertions.fail("header-floor", "no thread to measure")
                return
            }
            let statuses: [ThreadStatus] = [
                .idle, .running, .waiting, .waitingApproval, .waitingInput, .backgroundWork,
                .error, .archived, .settled, .done, .reviewing, .fixing, .readyToMerge,
            ]
            // What genuinely cannot compress: the two fixed badges and the
            // paddings and spacings around them. The title is excluded because
            // it truncates and the git strip because it scrolls — both degrade
            // without becoming unreachable. A few points are still reserved so
            // the title is not reduced to literally nothing at the minimum.
            let headerPadding: CGFloat = 32  // .padding(.horizontal, 16)
            let clusterSpacing: CGFloat = 32  // HStack(spacing: 16), two gaps
            let truncatedTitleRoom: CGFloat = 24
            var widest: (status: ThreadStatus, width: CGFloat) = (.idle, 0)
            for status in statuses {
                let host = NSHostingView(
                    rootView: HStack(spacing: 16) {
                        ProviderBadge(provider: thread.provider, modelID: thread.modelID)
                        StatusBadge(status: status, stalled: false)
                    })
                host.frame = NSRect(x: 0, y: 0, width: 1400, height: 90)
                host.layoutSubtreeIfNeeded()
                let width =
                    host.fittingSize.width + headerPadding + clusterSpacing
                    + truncatedTitleRoom
                if width > widest.width { widest = (status, width) }
            }
            let floor = WindowSizing.minContentWidth
            print(
                "UIProbe: header-floor widest incompressible=\(Int(widest.width))pt at "
                    + "status=\(widest.status.rawValue), floor=\(Int(floor))pt")
            if widest.width <= floor {
                UIProbeAssertions.pass(
                    "header-floor",
                    "floor \(Int(floor))pt covers the widest header state "
                        + "(\(Int(widest.width))pt at \(widest.status.rawValue), "
                        + "\(Int(floor - widest.width))pt spare)")
            } else {
                UIProbeAssertions.fail(
                    "header-floor",
                    "floor \(Int(floor))pt is under the header's incompressible width "
                        + "\(Int(widest.width))pt at status=\(widest.status.rawValue); "
                        + "the fixed chrome would clip at the window minimum")
            }
        }

        /// The late-arriving VCS status case, driven deterministically rather
        /// than waiting for the mock to happen to be slow: blank the strip, let
        /// it lay out empty, then hand it a status wide enough to overflow and
        /// assert it comes to rest at its trailing edge. This is the path where
        /// the scroll view has already anchored an empty strip, so growth has
        /// to re-anchor it or the git actions menu is off-screen.
        private static func probeLateVcsStatusAnchor(
            multi: MultiDeviceModel, dir: String
        ) async {
            let model = multi.local
            guard let mock = model.backendForShutdown as? MockBackend else {
                print("UIProbe: late-status skipped (live backend run)")
                return
            }
            guard let threadID = model.selectedThreadID else {
                UIProbeAssertions.fail("late-status", "no selected thread")
                return
            }

            /// Waits for the strip to report a settled geometry for this thread.
            func settledMetrics() async -> ChatHeaderView.GitStripMetrics? {
                var settled: ChatHeaderView.GitStripMetrics?
                var stableFor = 0
                for _ in 0..<40 {
                    try? await Task.sleep(for: .milliseconds(250))
                    guard let metrics = UIProbeGitStrip.metrics(for: threadID) else { continue }
                    if settled == metrics {
                        stableFor += 1
                        if stableFor >= 3 { return metrics }
                    } else {
                        stableFor = 0
                    }
                    settled = metrics
                }
                return settled
            }

            // 1. Blank the strip: a non-repo status renders no git controls.
            UIProbeGitStrip.reset()
            await mock.injectVcsStatus(
                threadID: threadID,
                status: VcsStatus(
                    isRepo: false, branch: nil, isDefaultBranch: false, changedFileCount: 0,
                    insertions: 0, deletions: 0, aheadCount: 0, behindCount: 0,
                    hasUpstream: false))
            try? await mock.refreshVcsStatus(threadID: threadID)
            let empty = await settledMetrics()
            print(
                "UIProbe: late-status emptied strip content="
                    + "\(empty.map { Int($0.contentWidth) } ?? -1)")

            // 2. Status arrives, wide enough to overflow any header.
            UIProbeGitStrip.reset()
            await mock.injectVcsStatus(
                threadID: threadID,
                status: VcsStatus(
                    isRepo: true,
                    branch: "sergecode/status-that-arrives-after-the-strip-has-already-laid-out",
                    isDefaultBranch: false,
                    changedFileCount: 4242,
                    insertions: 31337,
                    deletions: 2718,
                    aheadCount: 42,
                    behindCount: 17,
                    hasUpstream: true,
                    hasPrimaryRemote: true,
                    prNumber: 267,
                    prTitle: "Stop the window resizing itself",
                    prURL: "https://github.com/SergeSerb2/SergeCode/pull/267",
                    prState: .open,
                    isDraftPR: true,
                    unresolvedReviewThreadCount: 9,
                    prMergeStateStatus: "dirty"))
            try? await mock.refreshVcsStatus(threadID: threadID)
            guard let grown = await settledMetrics(), grown.contentWidth > 0 else {
                UIProbeAssertions.fail(
                    "late-status", "strip never reported content after the status arrived")
                return
            }
            print("UIProbe: late-status \(UIProbeGitStrip.describe())")
            guard grown.overflow.isOverflowing else {
                UIProbeAssertions.fail(
                    "late-status",
                    "strip did not overflow (content \(Int(grown.contentWidth)) in "
                        + "\(Int(grown.containerWidth))); the check proves nothing")
                return
            }
            if grown.isAtTrailingEdge {
                UIProbeAssertions.pass(
                    "late-status",
                    "strip anchored at \(Int(grown.contentOffsetX)) of "
                        + "\(Int(grown.trailingEdgeOffset)) after a late status")
            } else {
                UIProbeAssertions.fail(
                    "late-status",
                    "strip rested at \(Int(grown.contentOffsetX)) of "
                        + "\(Int(grown.trailingEdgeOffset)); git actions off-screen")
            }
            snapshot("window-size-late-status", dir: dir)
        }

        private static func probeContentGrowthDoesNotResizeWindow(
            multi: MultiDeviceModel,
            dir: String,
            window: NSWindow,
            log: (String) -> Void
        ) async {
            let model = multi.local
            guard let mock = model.backendForShutdown as? MockBackend else {
                print("UIProbe: content-growth skipped (live backend run)")
                return
            }
            guard let threadID = model.selectedThreadID else {
                print("UIProbe: content-growth no selected thread")
                return
            }

            // Sit at the window minimum: the state where AppKit used to grow
            // the window the moment the content wanted more room.
            window.setContentSize(NSSize(width: 1, height: 1))
            try? await Task.sleep(for: .seconds(1.5))
            let frameBefore = window.frame
            let minBefore = window.contentMinSize
            let maxBefore = window.contentMaxSize
            let stripBefore = UIProbeGitStrip.metrics(for: threadID)?.contentWidth ?? 0
            log("content-growth-before")
            print(
                "UIProbe: content-growth maxBefore="
                    + "\(Int(min(maxBefore.width, 99999)))x\(Int(min(maxBefore.height, 99999))) "
                    + "stripContent=\(Int(stripBefore))")

            UIProbeGitStrip.reset()
            await mock.injectVcsStatus(
                threadID: threadID,
                status: VcsStatus(
                    isRepo: true,
                    branch: "sergecode/a-deliberately-enormous-branch-name-that-will-not-fit-anywhere",
                    isDefaultBranch: false,
                    changedFileCount: 12345,
                    insertions: 67890,
                    deletions: 54321,
                    aheadCount: 999,
                    behindCount: 888,
                    hasUpstream: true,
                    hasPrimaryRemote: true,
                    prNumber: 26777,
                    prTitle: "A pull request whose title is also far too long for the header band",
                    prURL: "https://github.com/SergeSerb2/SergeCode/pull/26777",
                    prState: .open,
                    isDraftPR: true,
                    unresolvedReviewThreadCount: 4321,
                    prMergeStateStatus: "dirty"))
            try? await mock.refreshVcsStatus(threadID: threadID)
            try? await Task.sleep(for: .seconds(2.5))

            let frameAfter = window.frame
            let minAfter = window.contentMinSize
            let stripAfter = UIProbeGitStrip.metrics(for: threadID)?.contentWidth ?? 0
            log("content-growth-after")
            print("UIProbe: content-growth stripContent=\(Int(stripAfter))")

            // A point of epsilon: AppKit nudges frames by fractions for display
            // scale, titlebar, and divider settling, and reporting that as a
            // resize would make the check flaky rather than strict.
            let epsilon: CGFloat = 1
            func differs(_ lhs: CGSize, _ rhs: CGSize) -> Bool {
                abs(lhs.width - rhs.width) > epsilon || abs(lhs.height - rhs.height) > epsilon
            }

            var failed = false
            if stripAfter <= stripBefore {
                failed = true
                UIProbeAssertions.fail(
                    "content-growth",
                    "strip did not grow (\(Int(stripBefore)) -> \(Int(stripAfter))); "
                        + "the check proves nothing")
            }
            if differs(frameAfter.size, frameBefore.size) {
                failed = true
                UIProbeAssertions.fail(
                    "content-growth",
                    "window resized \(Int(frameBefore.width))x\(Int(frameBefore.height)) -> "
                        + "\(Int(frameAfter.width))x\(Int(frameAfter.height))")
            }
            if differs(minAfter, minBefore) {
                failed = true
                UIProbeAssertions.fail(
                    "content-growth",
                    "window minimum moved \(Int(minBefore.width))x\(Int(minBefore.height)) -> "
                        + "\(Int(minAfter.width))x\(Int(minAfter.height))")
            }
            // The maximum is checked on both sides of the growth: a clamp that
            // let the content's current width become the window's ceiling would
            // show up here, once the strip is wider than the floor.
            let maxAfter = window.contentMaxSize
            for (label, size) in [("before", maxBefore), ("after", maxAfter)]
            where size.width < 10000 || size.height < 10000 {
                failed = true
                UIProbeAssertions.fail(
                    "content-growth",
                    "window maximum \(label) growth is capped at "
                        + "\(Int(size.width))x\(Int(size.height)); resizing is blocked")
            }
            // The other half of the contract: the clamp must not have turned a
            // resize bug into a max-size regression. `contentMaxSize` is only
            // the reported number — this asks AppKit for a bigger window after
            // the content grew and checks the frame actually followed.
            let expanded = NSSize(
                width: frameAfter.width + 400, height: frameAfter.height + 200)
            window.setContentSize(expanded)
            try? await Task.sleep(for: .seconds(1.5))
            let grownFrame = window.frame
            if grownFrame.width < frameAfter.width + 300 {
                failed = true
                UIProbeAssertions.fail(
                    "content-growth",
                    "window would not expand after the content grew: asked for "
                        + "\(Int(expanded.width)) wide, got \(Int(grownFrame.width))")
            }
            if !failed {
                UIProbeAssertions.pass(
                    "content-growth",
                    "strip \(Int(stripBefore)) -> \(Int(stripAfter))pt, window and minimum "
                        + "unchanged, still expandable to \(Int(grownFrame.width))pt")
            }
            snapshot("window-size-content-growth", window: window, dir: dir)
        }

        /// Checks that the chat header's git strip starts at its trailing edge
        /// — where the git actions menu lives — on first show and again after
        /// each thread switch. A strip that overflows but reports a zero offset
        /// has silently landed at the leading edge, which would bury the git
        /// actions behind a long branch name.
        private static func probeGitStripAnchor(
            multi: MultiDeviceModel, dir: String, window: NSWindow
        ) async {
            let model = multi.local
            let threadIDs = model.threads.prefix(3).map(\.id)
            guard !threadIDs.isEmpty else {
                UIProbeAssertions.fail("git-strip", "no threads to check")
                return
            }
            var checks = 0
            var failures = 0

            /// Reads the strip's geometry for `threadID` only, after the
            /// previous reading was cleared: a strip that never reports must
            /// fail rather than inherit the last thread's numbers. Samples
            /// until the offset stops moving, because the anchor animates and a
            /// mid-flight sample measures the animation, not where the strip
            /// came to rest.
            func check(_ label: String, threadID: String) async {
                var settled: ChatHeaderView.GitStripMetrics?
                var stableFor = 0
                var startedEmpty = false
                var sawAnything = false
                for _ in 0..<40 {
                    try? await Task.sleep(for: .milliseconds(250))
                    guard let metrics = UIProbeGitStrip.metrics(for: threadID) else { continue }
                    if !sawAnything {
                        sawAnything = true
                        startedEmpty = metrics.contentWidth == 0
                    }
                    guard metrics.contentWidth > 0 else { continue }
                    if settled == metrics {
                        stableFor += 1
                        if stableFor >= 3 { break }
                    } else {
                        stableFor = 0
                    }
                    settled = metrics
                }
                checks += 1
                guard let metrics = settled else {
                    failures += 1
                    UIProbeAssertions.fail(
                        "git-strip",
                        "\(label) no fresh geometry for \(threadID) "
                            + "(last reading from \(UIProbeGitStrip.latestThreadID ?? "nothing"))")
                    return
                }
                print("UIProbe: \(label) \(UIProbeGitStrip.describe())")
                // Reachability, not just placement: if the fixed chrome ever ate
                // the whole header, the strip's container would collapse and no
                // amount of scrolling would reach the git controls.
                if metrics.containerWidth <= 0 {
                    failures += 1
                    UIProbeAssertions.fail(
                        "git-strip",
                        "\(label) strip has no room at all (\(threadID)); "
                            + "git controls unreachable")
                    return
                }
                guard !metrics.isAtTrailingEdge else { return }
                if startedEmpty {
                    // No longer an excuse: the strip is rebuilt when its
                    // content appears, so a status that arrives after mount
                    // gets a first layout with content in it. Kept in the
                    // message because it is the harder case to debug.
                    print("UIProbe: git-strip \(label) strip had populated after mount")
                }
                failures += 1
                UIProbeAssertions.fail(
                    "git-strip", "\(label) not at trailing edge (\(threadID))")
            }

            // Thread switches: every thread starts at the trailing edge. The
            // selection is cleared first so re-selecting the already-selected
            // thread is still a real change — otherwise nothing re-renders and
            // the check would read as "no geometry" rather than measuring.
            for threadID in threadIDs {
                multi.selection = nil
                try? await Task.sleep(for: .seconds(0.5))
                UIProbeGitStrip.reset()
                multi.select(threadID: threadID, on: model.deviceID)
                // Nudge the window a point: scroll geometry only reports on
                // change, and a strip that mounts with the same size and offset
                // as the last one would otherwise report nothing at all — which
                // the identity check (correctly) treats as no evidence.
                try? await Task.sleep(for: .seconds(1))
                window.setContentSize(
                    NSSize(width: window.frame.width + 1, height: window.frame.height - 52))
                await check("thread-switch", threadID: threadID)
            }

            // Header width changes: the case where a scroll view keeps a stale
            // offset and drifts off the trailing edge. Widths only grow, so none
            // of them can be refused by the window minimum (a refused resize
            // would emit no geometry at all).
            if let threadID = model.selectedThreadID {
                let base = window.frame.width
                for delta in [80.0, 320.0, 200.0] {
                    UIProbeGitStrip.reset()
                    window.setContentSize(NSSize(width: base + delta, height: 600))
                    await check("resize-\(Int(base + delta))", threadID: threadID)
                }
            }

            if failures == 0 {
                UIProbeAssertions.pass("git-strip", "anchor held across \(checks) checks")
            }
            snapshot("window-size-git-strip", dir: dir)
        }


        /// Dumps the AppKit split-view panes backing NavigationSplitView, so
        /// the window minimum can be attributed to individual columns.
        private static func logSplitViews(_ window: NSWindow) {
            func walk(_ view: NSView) {
                if let split = view as? NSSplitView {
                    let panes = split.arrangedSubviews.map { Int($0.frame.width) }
                    print("UIProbe: window-size splitview panes=\(panes)")
                }
                for sub in view.subviews { walk(sub) }
            }
            if let root = window.contentView { walk(root) }
        }

        /// Reports each shell surface's minimum (fitting) size, so the
        /// contributor to an oversized window minimum can be identified.
        private static func runMinSize(multi: MultiDeviceModel, scenery: SceneryStore) async {
            let model = multi.local
            try? await Task.sleep(for: .seconds(2))
            if model.selectedThreadID == nil,
                let threadID = model.threads.first(where: { $0.id == "thread-1" })?.id
                    ?? model.threads.first?.id
            {
                multi.select(threadID: threadID, on: model.deviceID)
            }
            try? await Task.sleep(for: .seconds(2))
            func measure(_ name: String, _ view: some View) {
                let host = NSHostingView(rootView: AnyView(view))
                host.frame = NSRect(x: 0, y: 0, width: 1400, height: 900)
                host.layoutSubtreeIfNeeded()
                let fitting = host.fittingSize
                print("UIProbe: min-size \(name) = \(Int(fitting.width))x\(Int(fitting.height))")
            }
            measure("SidebarView", SidebarView(multi: multi, scenery: scenery, onToggleSidebar: {}))
            measure("ChatScreen", ChatScreen(model: model, scenery: scenery))
            measure("ComposerBar", ComposerBar(model: model, accent: AlpineTheme.accent))
            if let thread = model.selectedThread {
                measure(
                    "ChatHeaderView",
                    ChatHeaderView(
                        thread: thread, model: model, scenery: scenery,
                        threadKey: model.scopedThreadKey(thread.id)))
                measure("InspectorPanel", InspectorPanel(model: model, threadID: thread.id))
                measure("ChatFollowUpBar", ChatFollowUpBar(model: model))
                measure("DiffReviewView", DiffReviewView(model: model, threadID: thread.id))
                measure("VcsToolbar", VcsToolbar(model: model, threadID: thread.id))
                measure(
                    "ProviderLabel",
                    ProviderLabel(provider: thread.provider, modelID: thread.modelID, iconSize: 13))
            }
            NSApp.terminate(nil)
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
