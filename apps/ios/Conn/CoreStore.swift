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
    private(set) var offlineReader: OfflineReader?
    private(set) var isSending = false
    var lastError: String?
    /// The connected server's environment id (its `/.well-known/t3/environment`).
    private(set) var environmentId: String?
    /// A thread to show, set by a `conn://thread/...` URL or a push tap; the workspace consumes it.
    private(set) var pendingLink: ThreadLink?
    /// The thread inbox is on screen (no thread pushed, no sheet), for push suppression.
    var isInboxVisible = false
    /// Bumped whenever the server's provider list changes; model pickers re-read on it.
    private(set) var providersRevision = 0
    /// Each thread's unsent composer text, by thread id (mobile's composer drafts by thread key).
    /// It lives here, not in the view, so a failed send restores into the thread's draft even
    /// after the user left the thread.
    var drafts: [String: String] = [:]

    @ObservationIgnored private var core: ConnCore?
    @ObservationIgnored private var activeGeneration: UInt64 = 0
    /// A link that arrived before this connection knew its environment id.
    @ObservationIgnored private var deferredLink: ThreadLink?

    let scope: String
    private(set) var linked: [String: CoreStore] = [:]

    init(scope: String = "") {
        self.scope = scope
        if scope.isEmpty && ProcessInfo.processInfo.arguments.contains("--reset-session") {
            clearLinkedSessions()
            clearCacheIdentity()
            KeychainStore.clearSession(scope: scope)
        }
        if let stored = KeychainStore.loadSession(scope: scope) {
            connect(serverURL: stored.serverURL, credential: .bearer(token: stored.bearerToken))
            if scope.isEmpty {
                for id in UserDefaults.standard.stringArray(forKey: "linkedSessions") ?? [] {
                    if KeychainStore.loadSession(scope: id) != nil { linked[id] = CoreStore(scope: id) }
                }
            }
        }
    }

    func connectWithPairingURL(_ raw: String) {
        lastError = nil
        do {
            let parsed = try PairingURLParser.parse(raw)
            clearCacheIdentity()
            KeychainStore.clearSession(scope: scope)
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
        restoreThread(threadId)
    }

    func closeThread(_ threadId: String) {
        guard openThreadId == threadId else { return }
        openThreadId = nil
        openThread = nil
        core?.closeThread(threadId: threadId)
    }

    func sendMessage(threadId: String, text: String, mode: FfiSendMode = .auto) async -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard status == .connected, !trimmed.isEmpty, let core else { return false }
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

    /// The composer's model chip and the thread settings sheet's model list.
    func modelPicker(
        threadId: String,
        query: String = "",
        toggled: [String] = [],
        pending: (instanceId: String, model: String)? = nil
    ) async -> FfiModelPicker? {
        guard let core else { return nil }
        return await core.modelPicker(
            threadId: threadId,
            query: query,
            toggled: toggled,
            pendingInstanceId: pending?.instanceId,
            pendingModel: pending?.model
        )
    }

    /// Save in the thread settings sheet. `.unavailable` means the catalog dropped the pick and
    /// nothing was sent; `nil` means the send failed (see `lastError`).
    func saveThreadModel(threadId: String, instanceId: String, model: String) async -> FfiModelSave? {
        guard let core else { return nil }
        do {
            return try await core.saveThreadModel(threadId: threadId, instanceId: instanceId, model: model)
        } catch {
            lastError = error.localizedDescription
            return nil
        }
    }

    /// Asks the server once for the models of the thread's provider in the thread's cwd.
    /// Keeps the thread's workspace models fresh while the picker is open; the core decides
    /// whether to scan. Returns milliseconds until it wants to be asked again, if ever.
    func scanThreadWorkspaceModels(threadId: String) async -> UInt64? {
        guard let core else { return nil }
        return (try? await core.scanThreadWorkspaceModels(threadId: threadId)) ?? nil
    }

    /// Sends the thread's draft. Like mobile, the draft clears as the message goes out; a failed
    /// send merges the sent text back into that thread's draft, wherever the user is by then.
    func sendDraft(threadId: String) async -> Bool {
        let message = drafts[threadId] ?? ""
        drafts[threadId] = nil
        let sent = await sendMessage(threadId: threadId, text: message, mode: .auto)
        if !sent {
            let restored = composerRestoreDraft(current: drafts[threadId] ?? "", sent: message)
            drafts[threadId] = restored.isEmpty ? nil : restored
        }
        return sent
    }

    func stopThread(threadId: String) async {
        guard status == .connected, let core else { return }
        do {
            try await core.stopThread(threadId: threadId)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func respondApproval(threadId: String, requestId: String, decision: FfiApprovalDecision) async {
        guard status == .connected, let core else { return }
        do {
            try await core.respondApproval(threadId: threadId, requestId: requestId, decision: decision)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func respondUserInput(threadId: String, requestId: String, answers: [FfiUserInputSubmission]) async {
        guard status == .connected, let core else { return }
        do {
            try await core.respondUserInput(threadId: threadId, requestId: requestId, answers: answers)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func dismissUserInput(threadId: String, requestId: String) async {
        guard status == .connected, let core else { return }
        do {
            try await core.dismissUserInput(threadId: threadId, requestId: requestId)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func answerSecretRequest(threadId: String, turnItemId: String, secret: String?) async {
        guard status == .connected, let core else { return }
        do {
            try await core.answerSecretRequest(threadId: threadId, turnItemId: turnItemId, secret: secret)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func settleThread(threadId: String, settled: Bool) async {
        guard status == .connected, let core else { return }
        do {
            try await core.settleThread(threadId: threadId, settled: settled)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func pinThread(threadId: String, pinned: Bool) async {
        guard status == .connected, let core else { return }
        do {
            try await core.pinThread(threadId: threadId, pinned: pinned)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func renameThread(threadId: String, title: String) async {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard status == .connected, !trimmed.isEmpty, let core else { return }
        do {
            try await core.renameThread(threadId: threadId, title: trimmed)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func deleteThread(threadId: String) async {
        guard status == .connected, let core else { return }
        do {
            try await core.deleteThread(threadId: threadId)
            // `useThreadListActions`: a deleted thread's draft goes with it.
            drafts[threadId] = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    func markThreadUnread(threadId: String) async {
        guard status == .connected, let core else { return }
        do {
            try await core.markThreadUnread(threadId: threadId)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func launchThread(projectId: String, text: String) async -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard status == .connected, !trimmed.isEmpty, let core else { return nil }
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
        guard status == .connected, !trimmed.isEmpty, let core else { return nil }
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

    func addLinked(_ raw: String) {
        do {
            let parsed = try PairingURLParser.parse(raw)
            guard !([self] + Array(linked.values)).contains(where: { $0.serverURL == parsed.serverURL }) else {
                lastError = "This environment is already linked."
                return
            }
            let id = UUID().uuidString
            let child = CoreStore(scope: id)
            child.connect(serverURL: parsed.serverURL, credential: .pairingCode(code: parsed.pairingCode))
            linked[id] = child
            UserDefaults.standard.set(Array(linked.keys), forKey: "linkedSessions")
        } catch { lastError = error.localizedDescription }
    }

    func removeLinked(_ id: String) {
        linked.removeValue(forKey: id)?.disconnect()
        UserDefaults.standard.set(Array(linked.keys), forKey: "linkedSessions")
    }

    private func clearLinkedSessions() {
        for id in UserDefaults.standard.stringArray(forKey: "linkedSessions") ?? [] {
            if let child = linked.removeValue(forKey: id) { child.disconnect() }
            KeychainStore.clearSession(scope: id)
            let defaults = UserDefaults.standard
            if let name = defaults.string(forKey: "offlinePairing" + id) {
                try? FileManager.default.removeItem(at: URL.applicationSupportDirectory.appending(path: name))
            }
            for key in ["offlinePairing", "offlineServer", "offlineEnvironment"] {
                defaults.removeObject(forKey: key + id)
            }
        }
        linked.removeAll()
        UserDefaults.standard.removeObject(forKey: "linkedSessions")
    }

    private func clearCacheIdentity() {
        let defaults = UserDefaults.standard
        if let name = defaults.string(forKey: "offlinePairing" + scope) {
            try? FileManager.default.removeItem(at: URL.applicationSupportDirectory.appending(path: name))
        }
        defaults.removeObject(forKey: "offlinePairing" + scope)
        defaults.removeObject(forKey: "offlineServer" + scope)
        defaults.removeObject(forKey: "offlineEnvironment" + scope)
    }

    private func prepareCache(_ handle: ConnCore, generation: UInt64) {
        let defaults = UserDefaults.standard
        if defaults.string(forKey: "offlineServer" + scope) != handle.serverUrl() {
            clearCacheIdentity()
        }
        let name = defaults.string(forKey: "offlinePairing" + scope) ?? "thread-cache-" + UUID().uuidString
        if let environmentId { defaults.set(environmentId, forKey: "offlineEnvironment" + scope) }
        else { environmentId = defaults.string(forKey: "offlineEnvironment" + scope) }
        defaults.set(name, forKey: "offlinePairing" + scope)
        defaults.set(handle.serverUrl(), forKey: "offlineServer" + scope)
        let directory = URL.applicationSupportDirectory.appending(path: name)
        Task {
            do {
                let reader = try await handle.prepareOffline(directory: directory.path)
                guard generation == activeGeneration else { return }
                offlineReader = reader
                let saved = await reader.savedShell()
                guard generation == activeGeneration else { return }
                if shell == nil { shell = saved }
                if let id = openThreadId { restoreThread(id) }
            } catch {
                guard generation == activeGeneration else { return }
                lastError = error.localizedDescription
            }
        }
    }

    private func restoreThread(_ id: String) {
        guard let reader = offlineReader, openThread == nil else { return }
        let generation = activeGeneration
        Task {
            guard let cached = try? await reader.recent(thread: id),
                  generation == activeGeneration, openThreadId == id,
                  openThread == nil, !cached.entries.isEmpty else { return }
            openThread = cached
        }
    }

    func reconnect() {
        core?.reconnect()
    }

    func disconnect() {
        if scope.isEmpty {
            clearLinkedSessions()
            Task { await PushRegistration.shared.unregister() }
        }
        activeGeneration &+= 1
        core?.disconnect()
        core = nil
        offlineReader = nil
        clearCacheIdentity()
        KeychainStore.clearSession(scope: scope)
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
            for child in linked.values { child.reconnect() }
        }
    }

    private func connect(serverURL: String, credential: FfiCredential) {
        activeGeneration &+= 1
        let generation = activeGeneration
        core?.disconnect()
        core = nil
        offlineReader = nil

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
            prepareCache(handle, generation: generation)
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
        if let child = linked.values.first(where: { $0.environmentId == link.environmentId }) {
            return isInboxVisible || child.openThreadId == link.threadId
        }
        guard environmentId == link.environmentId else { return false }
        return openThreadId == link.threadId || isInboxVisible
    }

    /// Opens a thread from a link: in place when it belongs to the connected environment,
    /// otherwise through Orbit (waking a sleeping Instance first).
    func open(_ link: ThreadLink) {
        if linked.values.contains(where: { $0.environmentId == link.environmentId }) {
            pendingLink = link
            return
        }
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
            UserDefaults.standard.set(id, forKey: "offlineEnvironment" + scope)
            if let link = deferredLink {
                deferredLink = nil
                open(link)
            }
        }
    }

    /// Connects to the link's environment through the Orbit Gateway, then shows the thread.
    private func connectThroughOrbit(_ link: ThreadLink) async {
        if scope.isEmpty && isPaired {
            let generation = activeGeneration
            let child = linked[link.environmentId] ?? CoreStore(scope: link.environmentId)
            linked[link.environmentId] = child
            await child.connectThroughOrbit(link)
            guard generation == activeGeneration, linked[link.environmentId] === child else { return }
            if child.isPaired {
                UserDefaults.standard.set(Array(linked.keys), forKey: "linkedSessions")
                pendingLink = link
            } else {
                lastError = child.lastError
                linked.removeValue(forKey: link.environmentId)
            }
            return
        }
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
            offlineReader = nil
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
                    prepareCache(handle, generation: generation)
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
        if newStatus != .connected { shell?.synchronized = false }
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
        KeychainStore.saveSession(serverURL: serverURL, bearerToken: token, scope: scope)
    }

    fileprivate func handleShell(_ snapshot: FfiShellSnapshot, generation: UInt64) {
        guard generation == activeGeneration else { return }
        if snapshot.synchronized || shell == nil { shell = snapshot }
    }

    /// The thread's stream reported `thread.deleted`. A thread missing from the shell is not
    /// deleted (older settled threads are left out), so only this and a successful delete clear
    /// a draft.
    fileprivate func handleThreadDeleted(_ threadId: String, generation: UInt64) {
        guard generation == activeGeneration else { return }
        drafts[threadId] = nil
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

    fileprivate func handleProvidersChanged(generation: UInt64) {
        guard generation == activeGeneration else { return }
        providersRevision &+= 1
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

    func onThreadDeleted(threadId: String) {
        let generation = self.generation
        Task { @MainActor [weak store] in
            store?.handleThreadDeleted(threadId, generation: generation)
        }
    }

    func onProvidersChanged() {
        let generation = self.generation
        Task { @MainActor [weak store] in
            store?.handleProvidersChanged(generation: generation)
        }
    }
}
