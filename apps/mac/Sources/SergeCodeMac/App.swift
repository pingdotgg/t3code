import SwiftUI

// App entry point. AppModel is a reference type (@Observable class), so a
// plain `let` on the App struct is sufficient — no @State needed (and @State
// is unusable here anyway, see Support/StateShim.swift). The model is passed
// explicitly down the view tree rather than injected via .environment, to
// match the explicit `model:` init parameter used by every screen-level view.
@main
struct SergeCodeApp: App {
    private static let backend: any BackendService = SergeCodeApp.makeBackend()
    private let dictation: DictationController
    private let model: AppModel
    private let multi: MultiDeviceModel
    // Alpine identity: Dolomites photo pool + per-thread scene assignment.
    private let scenery = SceneryStore()
    private let passport = PassportStore()
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    init() {
        let sharedDictation = DictationController()
        self.dictation = sharedDictation
        let localModel = AppModel(backend: SergeCodeApp.backend, dictation: sharedDictation)
        self.model = localModel
        self.multi = MultiDeviceModel(local: localModel)

        // macOS 26/27 beta: SwiftUI toolbar re-vends during an in-layout
        // render can raise NSInternalInconsistencyException from AppKit's
        // layout-feedback-loop guard. Registered (not set) so a user or
        // managed default can re-enable crash-on-exception; with this off,
        // AppKit logs the exception and drops the frame instead of aborting.
        UserDefaults.standard.register(defaults: ["NSApplicationCrashOnExceptions": false])
    }

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
            RootView(multi: multi, scenery: scenery, passport: passport)
                .environment(passport)
                .tint(AlpineTheme.accent(palette: activeSceneryPalette))
                // Behind-window liquid glass: strength tracks sceneryTranslucency
                // (1.0 = solid plate; lower = desktop visible through blur).
                // Requires TransparentWindowConfigurator (isOpaque=false).
                .containerBackground(for: .window) {
                    WindowGlassBackground(translucency: scenery.sceneryTranslucency)
                }
                // Punch the NSWindow so container glass can sample the desktop.
                .background(TransparentWindowConfigurator())
                .onAppear {
                    // Thread → project path so scenery set resolution can read
                    // per-project prefs (Phase 1 multi-set).
                    scenery.projectPathForThread = { [multi] threadID in
                        guard let thread = multi.local.threads.first(where: { $0.id == threadID }),
                            let project = multi.local.projects.first(where: { $0.id == thread.projectID })
                        else { return nil }
                        return project.path
                    }
                    multi.start()
                    appDelegate.multi = multi
                    #if DEBUG
                        UIProbe.runIfRequested(multi: multi, scenery: scenery)
                    #endif
                }
                .task {
                    await scenery.start()
                    passport.backfill(
                        sets: scenery.availableSets,
                        namesBySet: scenery.passportNamesBySet,
                        assignments: scenery.passportAssignments)
                }
                .onReceive(
                    NotificationCenter.default.publisher(
                        for: NSApplication.didBecomeActiveNotification)
                ) { _ in
                    scenery.reevaluateRotation()
                }
                .onReceive(
                    NotificationCenter.default.publisher(for: .NSCalendarDayChanged)
                ) { _ in
                    scenery.reevaluateRotation()
                }
        }
        .defaultSize(width: 1100, height: 720)

        Settings {
            SettingsScene(
                model: multi.local,
                scenery: scenery,
                backend: SergeCodeApp.backend,
                passport: passport)
        }
    }

    private var activeSceneryPalette: SceneryPalette? {
        guard let threadID = multi.activeModel.selectedThreadID else {
            return scenery.palette(for: nil)
        }
        return scenery.palette(
            for: scenery.photo(for: threadID),
            setId: scenery.resolvedSetId(forThread: threadID))
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
    var multi: MultiDeviceModel?
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
        guard let multi, !didCleanup else { return .terminateNow }
        didCleanup = true
        let done = DispatchSemaphore(value: 0)
        Task.detached {
            await multi.shutdown()
            done.signal()
        }
        // Each backend may own a sidecar whose stop path has a 2s grace, so
        // 6s covers the worst legitimate case while a hung teardown can
        // never wedge quit.
        _ = done.wait(timeout: .now() + 6)
        return .terminateNow
    }
}
