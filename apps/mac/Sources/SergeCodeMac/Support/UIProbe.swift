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
            print(
                "UIProbe: agents running=\(model.subagentTaskAggregator.runningCount) "
                    + "entries=\(model.subagentTaskAggregator.entries.count)")
            // The toolbar item owns the popover anchor. Toggle it through the
            // same in-process harness used by the other popover probes.
            toggleSection("agents")
            try? await Task.sleep(for: .seconds(1))
            snapshotAllWindows("2-agents-panel", dir: dir)
            toggleSection("agents")
            try? await Task.sleep(for: .seconds(1))
            snapshot("1-inspector-timeline", dir: dir)

            // Subagent stability: server-driven stall badge (appears on a
            // synthetic session.health stall, clears on active), the delegated
            // sibling-agent roster, and the session.exited stderr disclosure.
            await probeSubagentStability(model: model, multi: multi, dir: dir)

            // Subagent inner threads: drill into a running agent, then into a
            // settled one and promote its result into the parent composer.
            await probeSubagentInnerThread(model: model, dir: dir)

            if let remote = multi.remoteSessions.first {
                await probeRemoteDevice(
                    remote, multi: multi, scenery: scenery, passport: PassportStore(), dir: dir)
            }

            // Plan strip above the composer: expand, snapshot, collapse.
            toggleSection("plan")
            try? await Task.sleep(for: .seconds(1))
            snapshot("2-plan-expanded", dir: dir)
            toggleSection("plan")
            try? await Task.sleep(for: .seconds(1))

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
                if case .userMessage(_, let text, _) = $0 {
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

                // Window glass translucency: capture solid (1.0) and floor
                // (0.5) states, logging NSWindow isOpaque/clear + behind-window
                // effect presence. Self-capture cannot prove desktop bleed, but
                // it confirms the hierarchy is wired for it.
                await probeWindowTranslucency(scenery: scenery, dir: dir)

                // Create-image-set naming: mock backend returns locations;
                // register the resulting bare-title pool and create a thread.
                // Confirms new threads get "Iceland", not "Iceland 5".
                await probeIcelandSceneSetCreate(model: model, multi: multi, scenery: scenery)

                // Passport sheet: seed a temp store with Dolomites visits and
                // capture the sheet's view tree.
                await probePassport(scenery: scenery, dir: dir)

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
        /// a server `session.health` stall that badges the thread + agents
        /// panel and then clears on recovery, the delegated sibling-agent
        /// roster, and the `session.exited` stderr disclosure row.
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
            let projectID =
                model.threads.first { $0.id == threadID }?.projectID
                ?? model.projects.first?.id ?? "project-1"

            // Spawn a stalled delegated sibling agent (different provider) so
            // the roster and its stalled badge render.
            let sibling = await mock.probeCreateSiblingAgent(
                name: "codex worker", provider: .codex, projectID: projectID, stalled: true)
            // Stall the open thread's turn: subagent task rows + header +
            // sidebar dot flip to the server-driven warning state.
            await mock.probeSetThreadHealth(threadID: threadID, stalled: true)
            try? await Task.sleep(for: .seconds(1))
            let stalledThread = model.threads.first { $0.id == threadID }
            let stalledSibling = model.threads.first { $0.id == sibling.id }
            print(
                "UIProbe: stall injected threadStalled=\(stalledThread?.isStalled ?? false) "
                    + "siblingStalled=\(stalledSibling?.isStalled ?? false) "
                    + "siblingTitle=\(stalledSibling?.title ?? "nil")")
            toggleSection("agents")
            try? await Task.sleep(for: .seconds(1))
            snapshotAllWindows("2b-agents-stalled", dir: dir)
            toggleSection("agents")
            try? await Task.sleep(for: .seconds(0.5))

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

        /// Drives the nested subagent pane: open a running agent's inner
        /// thread (its progress log must render as a transcript), then a
        /// settled agent's, and promote its result into the parent composer.
        private static func probeSubagentInnerThread(model: AppModel, dir: String) async {
            guard let threadID = model.selectedThreadID else {
                print("UIProbe: subagent inner thread no selected thread")
                return
            }
            guard model.subagentTaskAggregator.task(taskId: "mock-subagent-1", threadID: threadID)
                != nil
            else {
                print("UIProbe: subagent inner thread skipped (live backend run)")
                return
            }

            // The mock's demo lifecycle folds new progress onto the seeded task
            // and may settle it mid-probe, so assert on the transcript (which
            // survives either way), not on the task still being `running`.
            model.openSubagent(taskId: "mock-subagent-1", threadID: threadID)
            try? await Task.sleep(for: .seconds(1))
            let opened = model.focusedSubagentTask(threadID: threadID)
            let progressVisible = mainWindowText().contains("Collecting subagent task call sites")
            print(
                "UIProbe: subagent inner thread task=\(opened?.taskId ?? "nil") "
                    + "state=\(opened?.state.rawValue ?? "nil") "
                    + "progressEntries=\(opened?.progressLog.count ?? 0) "
                    + "progressVisible=\(progressVisible)")
            snapshot("2e-subagent-inner-progress", dir: dir)

            model.openSubagent(taskId: "mock-subagent-2", threadID: threadID)
            try? await Task.sleep(for: .seconds(1))
            guard let settled = model.focusedSubagentTask(threadID: threadID),
                let result = SubagentInnerThread.resultText(for: settled),
                let promotion = SubagentInnerThread.promotionText(
                    for: settled, modelDisplayNames: model.modelDisplayNames)
            else {
                print("UIProbe: FAIL settled subagent has no promotable result")
                model.closeSubagent(threadID: threadID)
                return
            }
            let resultVisible = mainWindowText().contains("Three reports share one cause")
            snapshot("2f-subagent-inner-result", dir: dir)

            model.stageComposerTextAppending(promotion)
            model.closeSubagent(threadID: threadID)
            try? await Task.sleep(for: .seconds(1))
            let draft = model.composerDraft(for: threadID).text
            let promotedToComposer =
                draft.contains("> \(result.prefix(24))")
                && textView(containing: "Result from the") != nil
            let backOnTranscript = model.focusedSubagentTask(threadID: threadID) == nil
            print(
                "UIProbe: subagent inner thread result task=\(settled.taskId) "
                    + "resultVisible=\(resultVisible) promotedToComposer=\(promotedToComposer) "
                    + "backOnTranscript=\(backOnTranscript)")
            snapshot("2g-subagent-result-promoted", dir: dir)
            if progressVisible, resultVisible, promotedToComposer, backOnTranscript {
                print("UIProbe: PASS subagent inner thread navigate + progress + promote")
            } else {
                print("UIProbe: FAIL subagent inner thread surfaces incomplete")
            }

            // Leave the composer as the later prefill/queue probes expect it.
            model.stageComposerText("")
            try? await Task.sleep(for: .milliseconds(300))
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

        private static func probeRemoteDevice(
            _ session: RemoteDeviceSession,
            multi: MultiDeviceModel,
            scenery: SceneryStore,
            passport: PassportStore,
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
                multi: multi, scenery: scenery, passport: passport, dir: dir)

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
            passport: PassportStore,
            dir: String
        ) async {
            let hosting = NSHostingView(
                rootView: SidebarView(multi: multi, scenery: scenery, passport: passport))
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

        /// Exercises custom scenery set create → first thread title.
        ///
        /// Uses MockBackend for AI names (locations present) and a synthetic
        /// pool so Unsplash is not required. New pools use the bare place
        /// name only when no distinctly-named candidate exists; historical
        /// pool-index names still strip via `threadTitle`.
        private static func probeIcelandSceneSetCreate(
            model: AppModel, multi: MultiDeviceModel, scenery: SceneryStore
        ) async {
            let previousDefaultSetId = scenery.defaultSetId
            let probeRunID = UUID().uuidString
            let setId = "probe-iceland-\(probeRunID)"
            let mixedSetId = "probe-iceland-mixed-\(probeRunID)"
            let pollutedSetId = "probe-iceland-polluted-\(probeRunID)"
            defer {
                scenery.setDefaultSetId(previousDefaultSetId)
                // Early-return paths reach this defer before some sets were
                // ever registered — `.notFound` is expected there and stays
                // silent. Anything else (e.g. a disk error) would leave a
                // probe set persisted, so surface it.
                for probeSetId in [pollutedSetId, mixedSetId, setId] {
                    do {
                        try scenery.deleteCustomSet(id: probeSetId)
                    } catch SceneryStore.DeleteSetError.notFound {
                        // Set was never registered on this run.
                    } catch {
                        print("UIProbe: WARN failed to delete probe set \(probeSetId): \(error)")
                    }
                }
            }

            let backend = MockBackend()
            do {
                let generated = try await backend.generateScenerySet(location: "Iceland")
                let locations = SceneSetComposer.makeStoreLocations(from: generated.locations ?? [])
                print(
                    "UIProbe: iceland generate locations=\(locations.count) "
                        + "first=\(locations.first?.name ?? "nil")")
            } catch {
                print("UIProbe: iceland generateScenerySet failed: \(error)")
            }

            // New create path: bare set title for metadata-less pool photos.
            let barePhotos: [SceneryPhoto] = (1...5).map { i in
                SceneryPhoto(
                    id: "probe-ice-\(i)",
                    name: "Iceland",
                    averageColorHex: "#1a3a4a",
                    heroURL: URL(string: "https://images.unsplash.com/probe-ice-\(i)")!,
                    thumbURL: URL(string: "https://images.unsplash.com/probe-ice-\(i)-t")!,
                    rawURL: nil,
                    downloadLocationURL: nil,
                    photographerName: "Probe",
                    photographerProfileURL: nil)
            }
            let bareSet = ScenerySet(
                id: setId,
                title: "Iceland",
                origin: .custom,
                createdAt: Date(),
                queries: [SceneryQuery(text: "iceland landscape")],
                sceneNames: ["Iceland"],
                locations: [
                    SceneryLocation(name: "Iceland", query: "iceland landscape")
                ])
            scenery.registerSet(bareSet, pool: barePhotos, replacePoolResidue: true)
            scenery.setDefaultSetId(setId)

            if let project = model.projects.first {
                let thread = await model.createSceneThread(
                    projectID: project.id,
                    provider: .codex,
                    scenery: scenery,
                    scenerySetId: setId)
                let title = thread?.title ?? "nil"
                if let thread {
                    multi.select(threadID: thread.id, on: model.deviceID)
                }
                print("UIProbe: iceland new-set thread title=\(title)")
                if title != "Iceland" {
                    print("UIProbe: FAIL expected thread title Iceland, got \(title)")
                } else {
                    print("UIProbe: PASS iceland new-set thread title is bare place name")
                }
            } else {
                print("UIProbe: no project for iceland createSceneThread")
            }

            // Bug-fix coverage: a pool mixing distinctly-named photos
            // ("Skógafoss") with bare-named top-up photos ("Iceland") must
            // prefer the distinct place name for a new thread — this is the
            // exact "Iceland"-instead-of-"Skógafoss" regression.
            let mixedPhotos: [SceneryPhoto] =
                (1...3).map { i in
                    SceneryPhoto(
                        id: "probe-ice-mixed-bare-\(i)",
                        name: "Iceland",
                        averageColorHex: "#1a3a4a",
                        heroURL: URL(string: "https://images.unsplash.com/probe-ice-mixed-\(i)")!,
                        thumbURL: URL(string: "https://images.unsplash.com/probe-ice-mixed-\(i)-t")!,
                        rawURL: nil,
                        downloadLocationURL: nil,
                        photographerName: "Probe",
                        photographerProfileURL: nil)
                }
                + [
                    SceneryPhoto(
                        id: "probe-ice-mixed-named",
                        name: "Skógafoss",
                        averageColorHex: "#1a3a4a",
                        heroURL: URL(string: "https://images.unsplash.com/probe-ice-mixed-named")!,
                        thumbURL: URL(
                            string: "https://images.unsplash.com/probe-ice-mixed-named-t")!,
                        rawURL: nil,
                        downloadLocationURL: nil,
                        photographerName: "Probe",
                        photographerProfileURL: nil)
                ]
            let mixedSet = ScenerySet(
                id: mixedSetId,
                title: "Iceland",
                origin: .custom,
                createdAt: Date(),
                queries: [SceneryQuery(text: "iceland landscape")],
                sceneNames: ["Iceland", "Skógafoss"],
                locations: [
                    SceneryLocation(name: "Skógafoss", query: "skogafoss waterfall")
                ])
            scenery.registerSet(mixedSet, pool: mixedPhotos, replacePoolResidue: true)
            scenery.setDefaultSetId(mixedSetId)

            if let project = model.projects.first {
                let thread = await model.createSceneThread(
                    projectID: project.id,
                    provider: .codex,
                    scenery: scenery,
                    scenerySetId: mixedSetId)
                // The pool has exactly one distinctly-named photo, so the
                // filtered selection must land on it — assert exact title.
                if let title = thread?.title {
                    if let thread {
                        multi.select(threadID: thread.id, on: model.deviceID)
                    }
                    print("UIProbe: iceland mixed-pool thread title=\(title)")
                    if title == "Skógafoss" {
                        print("UIProbe: PASS iceland mixed-pool thread title is place-specific")
                    } else {
                        print("UIProbe: FAIL expected thread title Skógafoss, got \(title)")
                    }
                } else {
                    print("UIProbe: FAIL iceland mixed-pool thread creation returned no thread")
                }
            } else {
                print("UIProbe: no project for iceland mixed-pool createSceneThread")
            }

            // Defense in depth: polluted on-disk pool still strips to "Iceland".
            let polluted = SceneryPhoto(
                id: "probe-ice-polluted-5",
                name: "Iceland 5",
                averageColorHex: "#1a3a4a",
                heroURL: URL(string: "https://images.unsplash.com/probe-polluted")!,
                thumbURL: URL(string: "https://images.unsplash.com/probe-polluted-t")!,
                rawURL: nil,
                downloadLocationURL: nil,
                photographerName: "Probe",
                photographerProfileURL: nil)
            let pollutedSet = ScenerySet(
                id: pollutedSetId,
                title: "Iceland",
                origin: .custom,
                createdAt: Date(),
                queries: [SceneryQuery(text: "iceland landscape")],
                sceneNames: ["Iceland 1", "Iceland 2", "Iceland 3", "Iceland 4", "Iceland 5"])
            scenery.registerSet(pollutedSet, pool: [polluted], replacePoolResidue: true)
            let stripped = scenery.threadTitle(for: polluted)
            print("UIProbe: iceland polluted threadTitle=\(stripped)")
            if stripped != "Iceland" {
                print("UIProbe: FAIL expected stripped Iceland, got \(stripped)")
            } else {
                print("UIProbe: PASS polluted pool-index title strips to Iceland")
            }
        }

        /// Seeds a throwaway PassportStore with a few Dolomites visits (one
        /// place visited twice for the ×N badge) and captures PassportView
        /// hosted in its own window — sheets can't be presented
        /// programmatically here, and this exercises the identical view tree.
        private static func probePassport(scenery: SceneryStore, dir: String) async {
            let root = FileManager.default.temporaryDirectory
                .appendingPathComponent("probe-passport-\(UUID().uuidString)", isDirectory: true)
            defer { try? FileManager.default.removeItem(at: root) }

            let passport = PassportStore(rootOverride: root)
            let set = scenery.set(id: ScenerySet.dolomitesID)
            passport.ensurePage(
                setId: ScenerySet.dolomitesID,
                title: set?.title ?? "Dolomites",
                issuedAt: Date())
            let configuredSceneNames = set?.sceneNames ?? []
            let places = Array(
                (configuredSceneNames.isEmpty
                    ? ["Seceda", "Tre Cime", "Marmolada"]
                    : configuredSceneNames).prefix(3))
            for (index, place) in places.enumerated() {
                passport.recordVisit(
                    threadID: "probe-passport-\(index)",
                    setId: ScenerySet.dolomitesID,
                    placeName: place,
                    photoID: nil,
                    date: Date())
            }
            if let repeated = places.first {
                passport.recordVisit(
                    threadID: "probe-passport-repeat",
                    setId: ScenerySet.dolomitesID,
                    placeName: repeated,
                    photoID: nil,
                    date: Date())
            }

            let stamps = passport.pages.first?.stamps ?? []
            let repeatOK = stamps.first?.visitCount == 2
            let sceneNameCount = set?.sceneNames.count ?? 0
            print(
                "UIProbe: passport pages=\(passport.pages.count) stamps=\(stamps.count) "
                    + "repeatBadge=\(repeatOK) sceneNames=\(sceneNameCount)")
            if passport.pages.count == 1, stamps.count == places.count, repeatOK {
                print("UIProbe: PASS passport page seeded with stamps + repeat visit")
            } else {
                print("UIProbe: FAIL passport seeding unexpected shape")
            }

            let hosting = NSHostingView(
                rootView: PassportView(
                    scenery: scenery,
                    passport: passport,
                    isPresented: .constant(true)))
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 640, height: 560),
                styleMask: [.titled], backing: .buffered, defer: false)
            DarkAppearanceConfigurator.applyAppearance(to: window)
            window.contentView = hosting
            window.orderFront(nil)
            try? await Task.sleep(for: .seconds(2))
            if let view = window.contentView,
                let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds)
            {
                view.cacheDisplay(in: view.bounds, to: rep)
                if let data = rep.representation(using: .png, properties: [:]) {
                    let url = URL(fileURLWithPath: dir).appendingPathComponent("15-passport.png")
                    try? data.write(to: url)
                    print("UIProbe: wrote \(url.path)")
                }
            }
            window.orderOut(nil)
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
                rootView: EmptyStateView(scenery: scenery, onNewSession: {}))
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
                    backend: MockBackend(),
                    initialTab: tab))
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 760, height: 560),
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

        private static func userMessageCount(_ model: AppModel) -> Int {
            model.selectedTimeline().count {
                if case .userMessage = $0 { return true } else { return false }
            }
        }

        private static func firstUserMessageText(_ model: AppModel) -> String? {
            for item in model.selectedTimeline() {
                if case .userMessage(_, let text, _) = item { return text }
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

        private static func snapshot(_ name: String, window: NSWindow, dir: String) {
            guard let view = window.contentView,
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
