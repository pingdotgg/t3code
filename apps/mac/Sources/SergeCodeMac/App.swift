import SwiftUI

// App entry point. AppModel is a reference type (@Observable class), so a
// plain `let` on the App struct is sufficient — no @State needed (and @State
// is unusable here anyway, see Support/StateShim.swift). The model is passed
// explicitly down the view tree rather than injected via .environment, to
// match the explicit `model:` init parameter used by every screen-level view.
@main
struct SergeCodeApp: App {
    private static let backend: any BackendService = SergeCodeApp.makeBackend()
    private let model = AppModel(backend: SergeCodeApp.backend)
    // Alpine identity: Dolomites photo pool + per-thread scene assignment.
    private let scenery = SceneryStore()
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    // MockBackend when launched with `--mock` or `SERGECODE_MOCK=1`; otherwise
    // the real sidecar-backed LiveBackend.
    private static func makeBackend() -> any BackendService {
        if CommandLine.arguments.contains("--mock")
            || ProcessInfo.processInfo.environment["SERGECODE_MOCK"] == "1"
        {
            return MockBackend()
        }
        // The LAN-access preference is applied at spawn (the bind host is
        // fixed per sidecar process); toggling it in Settings ▸ iPhone
        // takes effect on the next launch.
        return LiveBackend(allowLanAccess: MobileAccessPreference.isEnabled)
    }

    var body: some Scene {
        WindowGroup {
            RootView(model: model, scenery: scenery)
                .tint(AlpineTheme.accent)
                .containerBackground(.thinMaterial, for: .window)
                .onAppear {
                    model.start()
                    appDelegate.backend = SergeCodeApp.backend
                    #if DEBUG
                        UIProbe.runIfRequested(model: model)
                    #endif
                }
                .task { await scenery.start() }
        }
        .defaultSize(width: 1100, height: 720)

        Settings {
            SettingsScene(model: model)
        }
    }
}

/// Ensures `backend.stop()` (SIGTERM -> 2s grace -> SIGKILL of the node
/// sidecar, plus socket/subscription teardown) actually runs before the app
/// quits. Without this, quitting orphans the sidecar child process —
/// `Process` does not kill children when its owning process exits.
///
/// Two deliberate choices here, both learned the hard way on this SDK:
/// - Raw SIGTERM/SIGINT (kill, launchd, logout) bypass
///   `applicationShouldTerminate` entirely, so DispatchSourceSignal routes
///   them into `NSApp.terminate`.
/// - `.terminateLater` + `reply(toApplicationShouldTerminate:)` is unusable
///   for async cleanup: while AppKit waits for the reply it spins a modal
///   run loop that services neither the main dispatch queue nor MainActor
///   tasks (verified empirically — GCD asyncAfter and MainActor Tasks both
///   starve), so the reply can never be sent from async work. Instead the
///   delegate blocks the main thread on a semaphore, bounded at 6s, while
///   `backend.stop()` runs on a detached task. That is safe precisely
///   because `BackendService.stop()` is actor- (not MainActor-) isolated
///   and never hops to the main actor; the UI is about to die anyway.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    var backend: (any BackendService)?
    private var signalSources: [DispatchSourceSignal] = []
    private var didCleanup = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { NSApp.terminate(nil) }
            source.resume()
            signalSources.append(source)
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let backend, !didCleanup else { return .terminateNow }
        didCleanup = true
        let done = DispatchSemaphore(value: 0)
        Task.detached {
            await backend.stop()
            done.signal()
        }
        // ServerProcess.stop() SIGKILLs the child after a 2s grace, so 6s
        // covers the worst legitimate case; a hung teardown must never
        // wedge quit.
        _ = done.wait(timeout: .now() + 6)
        return .terminateNow
    }
}
