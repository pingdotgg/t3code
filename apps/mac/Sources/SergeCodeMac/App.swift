import Foundation
import SwiftUI
import Sparkle

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
    // Sparkle auto-updater controller
    private let updaterController: SPUStandardUpdaterController
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    init() {
        // Initialize Sparkle updater controller. Not started for mock/probe
        // runs: those launch the raw build product (no .app bundle, so no
        // SUFeedURL), and Sparkle's startup failure is a modal NSAlert that
        // blocks the UI probe before it can capture anything.
        self.updaterController = SPUStandardUpdaterController(
            startingUpdater: !Self.shouldUseMock
                && ProcessInfo.processInfo.environment["SERGECODE_UI_PROBE"] == nil,
            updaterDelegate: nil,
            userDriverDelegate: nil)

        let sharedDictation = DictationController()
        self.dictation = sharedDictation
        let localModel = AppModel(backend: SergeCodeApp.backend, dictation: sharedDictation)
        self.model = localModel
        let multiModel = MultiDeviceModel(
            local: localModel,
            remoteDeviceStore: Self.makeRemoteDeviceStore())
        if Self.shouldSeedMockRemote {
            let descriptor = RemoteDeviceDescriptor(
                id: DeviceID(rawValue: "mock-mac-2"),
                name: "Mac mini — Studio",
                host: "mac-mini.local",
                port: 3773)
            let remoteModel = AppModel(
                backend: MockBackend(seedVariant: "studio"),
                deviceID: descriptor.id,
                deviceName: descriptor.name,
                capabilities: .remote,
                dictation: sharedDictation)
            multiModel.addSession(
                RemoteDeviceSession(descriptor: descriptor, model: remoteModel))
        }
        self.multi = multiModel

        // macOS 26/27 beta: SwiftUI toolbar re-vends during an in-layout
        // render can raise NSInternalInconsistencyException from AppKit's
        // layout-feedback-loop guard. Registered (not set) so a user or
        // managed default can re-enable crash-on-exception; with this off,
        // AppKit logs the exception and drops the frame instead of aborting.
        UserDefaults.standard.register(defaults: ["NSApplicationCrashOnExceptions": false])
    }

    private static var shouldUseMock: Bool {
        CommandLine.arguments.contains("--mock")
            || CommandLine.arguments.contains("--mock-remote")
            || ProcessInfo.processInfo.environment["SERGECODE_MOCK"] == "1"
            || ProcessInfo.processInfo.environment["SERGECODE_MOCK_REMOTE"] == "1"
    }

    private static var shouldSeedMockRemote: Bool {
        shouldUseMock
            && (CommandLine.arguments.contains("--mock-remote")
                || ProcessInfo.processInfo.environment["SERGECODE_MOCK_REMOTE"] == "1")
    }

    private static func makeRemoteDeviceStore() -> RemoteDeviceStore {
        guard shouldUseMock else { return RemoteDeviceStore() }
        let suiteName = "SergeCode.mock.remote-devices.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        return RemoteDeviceStore(defaults: defaults)
    }

    // MockBackend when launched with `--mock`/`--mock-remote` or the matching
    // environment flags; otherwise the real sidecar-backed LiveBackend.
    private static func makeBackend() -> any BackendService {
        if shouldUseMock {
            return MockBackend()
        }
        // The LAN-access and Tailscale preferences are applied at spawn (the
        // bind host and bootstrap envelope are fixed per sidecar process);
        // toggling them in Settings ▸ Devices takes effect on the next launch.
        return LiveBackend(
            allowLanAccess: MobileAccessPreference.isEnabled,
            tailscaleServeEnabled: TailscaleAccessPreference.isEnabled)
    }

    var body: some Scene {
        WindowGroup {
            RootView(multi: multi, scenery: scenery)
                .environment(\.colorScheme, .dark)
                .preferredColorScheme(.dark)
                .background(DarkAppearanceConfigurator())
                .tint(AlpineTheme.accent)
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
                    scenery.projectPathForThread = { [multi] threadKey in
                        for model in multi.allModels {
                            if let path = model.projectPath(forScopedThreadKey: threadKey) {
                                return path
                            }
                        }
                        return nil
                    }
                    multi.start()
                    appDelegate.multi = multi
                    #if DEBUG
                        UIProbe.runIfRequested(multi: multi, scenery: scenery)
                    #endif
                }
                .task {
                    Task { await CodeHighlighter.shared.warm() }
                    await scenery.start()
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
        .commands {
            CommandGroup(replacing: .appInfo) {
                // Plain button + AppKit-managed window: a custom View with
                // @Environment(\.openWindow) inside a CommandGroup crashes
                // AppKit menu layout on the macOS 27 beta SDK (uncaught
                // NSException in NSISEngine), so About avoids SwiftUI window
                // scenes entirely.
                Button("About SurgeCode") {
                    AboutWindowController.shared.show()
                }
            }
            CommandGroup(after: .appInfo) {
                Button("Version \(AppVersion.fullVersion)") {}
                    .disabled(true)
                Divider()
            }
            CommandGroup(after: .appInfo) {
                Button("Check for Updates...") {
                    updaterController.checkForUpdates(nil)
                }
            }
            // `.replacing` (not `.after`): a bare `WindowGroup` auto-vends a
            // "New Window" item already bound to ⌘N, which would otherwise
            // race our own ⌘N item for the same key equivalent (and a second
            // top-level window here would just be a redundant duplicate of
            // the same sidebar/model, not a useful window to spawn).
            CommandGroup(replacing: .newItem) {
                // Same AppKit-window workaround as About above — this opens
                // an independent standalone window rather than RootView's
                // own New Session sheet.
                Button("New Session") {
                    NewSessionWindowController.shared.show(
                        multi: multi, scenery: scenery)
                }
                .keyboardShortcut("n", modifiers: .command)
            }
        }

        Settings {
            SettingsScene(
                model: multi.local,
                scenery: scenery,
                backend: SergeCodeApp.backend,
                multi: multi)
                .environment(\.colorScheme, .dark)
                .preferredColorScheme(.dark)
                .background(DarkAppearanceConfigurator())
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
/// - The delegate synchronously collects the backends and waits on a bounded
///   semaphore while their actor-isolated stop paths run off-main. This keeps
///   the sidecars from being orphaned without awaiting MainActor work while
///   the main thread is blocked.
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

        let backends = multi.collectBackendsForShutdown()
        let done = DispatchSemaphore(value: 0)
        Task.detached {
            await withTaskGroup(of: Void.self) { group in
                for backend in backends {
                    group.addTask { await backend.stop() }
                }
            }
            done.signal()
        }
        _ = done.wait(timeout: .now() + 6)
        return .terminateNow
    }
}
