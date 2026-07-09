#if DEBUG
    import AppKit
    import SwiftUI

    /// Debug-only UI verification hook for agent/CI runs without screen
    /// recording or accessibility permissions: `SERGECODE_UI_PROBE=<dir>`
    /// (typically with `--mock`) selects the first thread, self-captures the
    /// window to PNGs in `<dir>` (in-process bitmap, no TCC prompt), opens
    /// main-area diff review, logs probe steps to stdout, and quits.
    @MainActor
    enum UIProbe {
        static func runIfRequested(model: AppModel) {
            guard let dir = ProcessInfo.processInfo.environment["SERGECODE_UI_PROBE"],
                !dir.isEmpty
            else { return }
            Task { await run(model: model, dir: dir) }
        }

        private static func run(model: AppModel, dir: String) async {
            try? FileManager.default.createDirectory(
                atPath: dir, withIntermediateDirectories: true)

            // Let the mock backend load, then select a thread so the
            // inspector has content. Prefer thread-1: it's the one the mock
            // seeds with plan progress, so the plan strip is exercised too.
            try? await Task.sleep(for: .seconds(2))
            if model.selectedThreadID == nil {
                model.selectedThreadID =
                    model.threads.first { $0.id == "thread-1" }?.id ?? model.threads.first?.id
            }
            // Let the inspector timeline present and the diff refresh land.
            try? await Task.sleep(for: .seconds(2))
            snapshot("1-inspector-timeline", dir: dir)

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

            // Retry: resending an existing user message appends a new user
            // row to the timeline (mock backend echoes sends).
            let before = userMessageCount(model)
            if let text = firstUserMessageText(model) {
                await model.send(text: text)
            }
            try? await Task.sleep(for: .seconds(1))
            print("UIProbe: retry user rows before=\(before) after=\(userMessageCount(model))")
            snapshot("8-after-retry", dir: dir)

            // Settings ▸ iPhone: enable the mobile-access preference so the
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
                MobileAccessPreference.setEnabled(true)
                await snapshotSettings(
                    tab: .iphone, name: "9-settings-iphone", model: model, dir: dir)
                await snapshotSettings(
                    tab: .connection, name: "10-settings-connection", model: model, dir: dir)
                MobileAccessPreference.setEnabled(previousMobileAccess)
                await snapshotSettings(
                    tab: .dictation, name: "11-settings-dictation", model: model, dir: dir)
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

            print("UIProbe: done")
            NSApp.terminate(nil)
        }

        /// Hosts SettingsScene in its own window on `tab` and captures it —
        /// the real Settings scene can't be opened programmatically without
        /// the menu, and this exercises the identical view tree.
        private static func snapshotSettings(
            tab: SettingsTab, name: String, model: AppModel, dir: String
        ) async {
            let hosting = NSHostingView(
                rootView: SettingsScene(model: model, initialTab: tab))
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 560, height: 420),
                styleMask: [.titled], backing: .buffered, defer: false)
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
            guard let root = NSApp.windows.first(where: { $0.isVisible })?.contentView
            else { return nil }
            return textViews(in: root).first { $0.string.contains(needle) }
        }

        private static func textViews(in view: NSView) -> [NSTextView] {
            var found: [NSTextView] = []
            for subview in view.subviews {
                if let text = subview as? NSTextView { found.append(text) }
                found += textViews(in: subview)
            }
            return found
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
