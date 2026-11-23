import Foundation
import Observation
import SwiftUI

@MainActor
@Observable
final class CoreStore {
    private(set) var status: FfiConnectionStatus?
    private(set) var shell: FfiShellSnapshot?
    private(set) var openThread: FfiThreadSnapshot?
    private(set) var openThreadId: String?
    private(set) var serverURL: String?
    private(set) var isPaired = false
    private(set) var isSending = false
    var lastError: String?
    /// The connected server's environment id (its `/.well-known/t3/environment`).
    private(set) var environmentId: String?
    /// A thread to show, set by a `conn://thread/...` URL or a push tap; the workspace consumes it.
    private(set) var pendingLink: ThreadLink?
    /// The thread inbox is on screen (no thread pushed, no sheet), for push suppression.
    var isInboxVisible = false

    @ObservationIgnored private var core: ConnCore?
    @ObservationIgnored private var activeGeneration: UInt64 = 0
    /// A link that arrived before this connection knew its environment id.
    @ObservationIgnored private var deferredLink: ThreadLink?

    init() {
        if ProcessInfo.processInfo.arguments.contains("--reset-session") {
            KeychainStore.clearSession()
        }
        if let stored = KeychainStore.loadSession() {
            connect(serverURL: stored.serverURL, credential: .bearer(token: stored.bearerToken))
        }
    }

    func connectWithPairingURL(_ raw: String) {
        lastError = nil
        do {
            let parsed = try PairingURLParser.parse(raw)
            KeychainStore.clearSession()
            connect(serverURL: parsed.serverURL, credential: .pairingCode(code: parsed.pairingCode))
        } catch {
            lastError = error.localizedDescription
        }
    }

    func openThread(_ threadId: String) {
        if let current = openThreadId, current != threadId {
            core?.closeThread(threadId: current)
            openThread = nil
        }
        openThreadId = threadId
        core?.openThread(threadId: threadId)
    }

    func closeThread(_ threadId: String) {
        guard openThreadId == threadId else { return }
        openThreadId = nil
        openThread = nil
        core?.closeThread(threadId: threadId)
    }

    func sendMessage(threadId: String, text: String, mode: FfiSendMode = .auto) async -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let core else { return false }
        isSending = true
        lastError = nil
        defer { isSending = false }
        do {
            try await core.sendMessage(threadId: threadId, text: trimmed, mode: mode)
            PushRegistration.shared.noteThreadActivity()
            return true
        } catch {
            lastError = error.localizedDescription
            return false
        }
    }

    func stopThread(threadId: String) async {
        guard let core else { return }
        do {
            try await core.stopThread(threadId: threadId)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func respondApproval(threadId: String, requestId: String, decision: FfiApprovalDecision) async {
        guard let core else { return }
        do {
            try await core.respondApproval(threadId: threadId, requestId: requestId, decision: decision)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func respondUserInput(threadId: String, requestId: String, answers: [FfiUserInputSubmission]) async {
        guard let core else { return }
        do {
            try await core.respondUserInput(threadId: threadId, requestId: requestId, answers: answers)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func dismissUserInput(threadId: String, requestId: String) async {
        guard let core else { return }
        do {
            try await core.dismissUserInput(threadId: threadId, requestId: requestId)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func answerSecretRequest(threadId: String, turnItemId: String, secret: String?) async {
        guard let core else { return }
        do {
            try await core.answerSecretRequest(threadId: threadId, turnItemId: turnItemId, secret: secret)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func settleThread(threadId: String, settled: Bool) async {
        guard let core else { return }
        do {
            try await core.settleThread(threadId: threadId, settled: settled)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func pinThread(threadId: String, pinned: Bool) async {
        guard let core else { return }
        do {
            try await core.pinThread(threadId: threadId, pinned: pinned)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func renameThread(threadId: String, title: String) async {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let core else { return }
        do {
            try await core.renameThread(threadId: threadId, title: trimmed)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func deleteThread(threadId: String) async {
        guard let core else { return }
        do {
            try await core.deleteThread(threadId: threadId)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func markThreadUnread(threadId: String) async {
        guard let core else { return }
        do {
            try await core.markThreadUnread(threadId: threadId)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func launchThread(projectId: String, text: String) async -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let core else { return nil }
        isSending = true
        lastError = nil
        defer { isSending = false }
        do {
            let threadId = try await core.launchThread(projectId: projectId, text: trimmed)
            PushRegistration.shared.noteThreadActivity()
            return threadId
        } catch {
            lastError = error.localizedDescription
            return nil
        }
    }

    func launchGeneralThread(text: String) async -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let core else { return nil }
        isSending = true
        lastError = nil
        defer { isSending = false }
        do {
            let threadId = try await core.launchGeneralThread(text: trimmed)
            PushRegistration.shared.noteThreadActivity()
            return threadId
        } catch {
            lastError = error.localizedDescription
            return nil
        }
    }

    func reconnect() {
        core?.reconnect()
    }

    func disconnect() {
        Task { await PushRegistration.shared.unregister() }
        activeGeneration &+= 1
        core?.disconnect()
        core = nil
        KeychainStore.clearSession()
        status = nil
        shell = nil
        openThread = nil
        openThreadId = nil
        serverURL = nil
        environmentId = nil
        pendingLink = nil
        deferredLink = nil
        isPaired = false
        lastError = nil
    }

    func handleScenePhase(_ phase: ScenePhase) {
        if phase == .active, core != nil {
            reconnect()
        }
    }

    private func connect(serverURL: String, credential: FfiCredential) {
        activeGeneration &+= 1
        let generation = activeGeneration
        core?.disconnect()
        core = nil

        self.serverURL = serverURL
        self.status = .connecting
        self.shell = nil
        self.openThread = nil
        self.openThreadId = nil
        self.environmentId = nil
        self.lastError = nil

        let listener = ListenerBridge(store: self, generation: generation)
        do {
            let handle = try ConnCore.connect(
                serverUrl: serverURL,
                credential: credential,
                listener: listener
            )
            self.core = handle
            self.isPaired = true
        } catch {
            self.status = .failed(message: error.localizedDescription)
            self.lastError = error.localizedDescription
            self.isPaired = false
        }
    }

    // MARK: - Thread links (conn://thread/<environment>/<thread> and push taps)

    /// True when that thread, or the inbox, of the connected environment is on screen.
    func isShowing(_ link: ThreadLink) -> Bool {
        guard environmentId == link.environmentId else { return false }
        return openThreadId == link.threadId || isInboxVisible
    }

    /// Opens a thread from a link: in place when it belongs to the connected environment,
    /// otherwise through Orbit (waking a sleeping Instance first).
    func open(_ link: ThreadLink) {
        if let environmentId {
            if environmentId == link.environmentId {
                pendingLink = link
            } else {
                Task { await connectThroughOrbit(link) }
            }
        } else if core != nil {
            // Still connecting: decide once the environment id is known.
            deferredLink = link
        } else {
            Task { await connectThroughOrbit(link) }
        }
    }

    /// Hands the pending link to the workspace once.
    func consumePendingLink() -> ThreadLink? {
        defer { pendingLink = nil }
        return pendingLink
    }

    private func refreshEnvironmentId(generation: UInt64) {
        guard let serverURL, let base = URL(string: serverURL) else { return }
        let url = base.appending(path: ".well-known/t3/environment")
        Task {
            guard let response = try? await URLSession.shared.data(from: url),
                  let object = try? JSONSerialization.jsonObject(with: response.0) as? [String: Any],
                  let id = object["environmentId"] as? String,
                  generation == activeGeneration
            else { return }
            environmentId = id
            if let link = deferredLink {
                deferredLink = nil
                open(link)
            }
        }
    }

    /// Connects to the link's environment through the Orbit Gateway, then shows the thread.
    private func connectThroughOrbit(_ link: ThreadLink) async {
        do {
            let orbit = try OrbitCore(gatewayUrl: nil)
            guard let target = try await orbit.fleet().first(where: { $0.serverId == link.environmentId }) else {
                lastError = "Orbit doesn't list the environment of that thread."
                return
            }
            if let instanceId = target.instanceId, target.powerState == .stopped {
                _ = try await orbit.wakeInstance(instanceId: instanceId)
            }

            activeGeneration &+= 1
            let generation = activeGeneration
            core?.disconnect()
            core = nil
            serverURL = target.url
            status = .connecting
            shell = nil
            openThread = nil
            openThreadId = nil
            environmentId = link.environmentId
            deferredLink = nil
            lastError = nil

            let listener = ListenerBridge(store: self, generation: generation)
            var lastFailure: Error?
            // A woken Instance takes a little while to serve; keep trying for about a minute.
            for _ in 0..<12 {
                do {
                    let handle = try await orbit.connectEnvironment(
                        serverId: target.serverId,
                        cachedBearer: nil,
                        listener: listener
                    )
                    guard generation == activeGeneration else {
                        handle.disconnect()
                        return
                    }
                    core = handle
                    serverURL = handle.serverUrl()
                    isPaired = true
                    pendingLink = link
                    return
                } catch {
                    lastFailure = error
                    try? await Task.sleep(for: .seconds(5))
                    guard generation == activeGeneration else { return }
                }
            }
            if let lastFailure { throw lastFailure }
        } catch {
            lastError = error.localizedDescription
            if core == nil, serverURL != nil {
                status = .failed(message: error.localizedDescription)
            }
        }
    }

    fileprivate func handleStatus(_ newStatus: FfiConnectionStatus, generation: UInt64) {
        guard generation == activeGeneration else { return }
        status = newStatus
        if case let .failed(message) = newStatus {
            lastError = message
        } else if newStatus == .connected {
            lastError = nil
            if environmentId == nil {
                refreshEnvironmentId(generation: generation)
            }
        }
    }

    fileprivate func handleBearerIssued(_ token: String, generation: UInt64) {
        guard generation == activeGeneration, let serverURL else { return }
        KeychainStore.saveSession(serverURL: serverURL, bearerToken: token)
    }

    fileprivate func handleShell(_ snapshot: FfiShellSnapshot, generation: UInt64) {
        guard generation == activeGeneration else { return }
        shell = snapshot
    }

    fileprivate func handleThread(_ snapshot: FfiThreadSnapshot, generation: UInt64) {
        guard generation == activeGeneration else { return }
        if openThreadId == snapshot.threadId {
            openThread = snapshot
        }
    }

    fileprivate func handleError(_ message: String, generation: UInt64) {
        guard generation == activeGeneration else { return }
        lastError = message
    }
}

private final class ListenerBridge: CoreListener, @unchecked Sendable {
    private weak var store: CoreStore?
    private let generation: UInt64

    init(store: CoreStore, generation: UInt64) {
        self.store = store
        self.generation = generation
    }

    func onStatus(status: FfiConnectionStatus) {
        let generation = self.generation
        Task { @MainActor [weak store] in
            store?.handleStatus(status, generation: generation)
        }
    }

    func onBearerIssued(token: String) {
        let generation = self.generation
        Task { @MainActor [weak store] in
            store?.handleBearerIssued(token, generation: generation)
        }
    }

    func onShell(snapshot: FfiShellSnapshot) {
        let generation = self.generation
        Task { @MainActor [weak store] in
            store?.handleShell(snapshot, generation: generation)
        }
    }

    func onThread(snapshot: FfiThreadSnapshot) {
        let generation = self.generation
        Task { @MainActor [weak store] in
            store?.handleThread(snapshot, generation: generation)
        }
    }

    func onError(message: String) {
        let generation = self.generation
        Task { @MainActor [weak store] in
            store?.handleError(message, generation: generation)
        }
    }
}
