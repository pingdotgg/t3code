import Foundation
import Observation
import SwiftUI

/// The launch path through Orbit, shown while no connection is up.
enum OrbitConnectState: Equatable {
    case connecting
    case failed(message: String, detail: String?)
}

/// One environment's store: the main one (`scope` empty) or a linked one. It renders its
/// `ConnSession`'s state. Rust owns the connection: which attempt counts, its status, what Retry
/// repeats, when to re-pair, and the offline cache.
@MainActor
@Observable
final class CoreStore {
    private(set) var state: FfiSessionState?
    private(set) var shell: FfiShellSnapshot?
    private(set) var openThread: FfiThreadSnapshot?
    private(set) var openThreadId: String?
    private(set) var offlineReader: OfflineReader?
    private(set) var isSending = false
    var lastError: String?
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

    @ObservationIgnored private var session: ConnSession?
    private var core: ConnCore? { session?.core() }

    let scope: String
    private(set) var linked: [String: CoreStore] = [:]

    /// The connection status the workspace shows inline. Once this scope has connected, a
    /// reconnect or re-pair shows here, so the workspace and its open thread stay up.
    var status: FfiConnectionStatus? {
        switch state?.phase {
        case let .live(status): status
        case .connecting where hasConnected: .connecting
        case let .failed(message, _, _) where hasConnected: .failed(message: message)
        default: nil
        }
    }

    var isPaired: Bool {
        if case .live = state?.phase { true } else { false }
    }

    /// Rust: this scope has had a working connection this launch.
    var hasConnected: Bool { state?.hasConnected ?? false }

    /// Rust: grows when this scope connects to a different server than before.
    var identityEpoch: UInt64 { state?.identityEpoch ?? 0 }

    /// The workspace, rather than the Orbit or pairing screen: connected before, or connecting to
    /// this launch's first server (its offline history shows meanwhile). After a switch to
    /// another server, the connecting screen shows until that one connects.
    var showsWorkspace: Bool { hasConnected || (isPaired && identityEpoch == 0) }
    var serverURL: String? { state?.serverUrl }
    /// The connected server's environment id.
    var environmentId: String? { state?.environmentId }

    var orbitConnect: OrbitConnectState? {
        switch state?.phase {
        case .connecting: .connecting
        case .live where !hasConnected: .connecting
        case let .failed(message, detail, _): .failed(message: message, detail: detail)
        default: nil
        }
    }

    init(scope: String = "") {
        self.scope = scope
        let arguments = ProcessInfo.processInfo.arguments
        if scope.isEmpty && arguments.contains("--reset-session") {
            clearLinkedSessions()
            KeychainStore.clearSession(scope: scope)
            try? FileManager.default.removeItem(at: Self.cacheDirectory(scope))
        }
        do {
            session = try ConnSession(
                gatewayUrl: nil,
                cacheDirectory: Self.cacheDirectory(scope).path,
                listener: SessionBridge(store: self, scope: scope)
            )
        } catch {
            lastError = error.localizedDescription
        }
        let saved = KeychainStore.loadSession(scope: scope).map {
            FfiSavedSession(
                serverUrl: $0.serverURL,
                bearer: $0.bearerToken,
                orbitServerId: $0.orbitServerId,
                environmentId: $0.environmentId
            )
        }
        guard scope.isEmpty else {
            session?.restore(saved: saved)
            return
        }
        guard !arguments.contains("--manual-pairing") else { return }
        session?.launch(saved: saved)
        for id in UserDefaults.standard.stringArray(forKey: "linkedSessions") ?? [] {
            if KeychainStore.loadSession(scope: id) != nil { linked[id] = CoreStore(scope: id) }
        }
    }

    private static func cacheDirectory(_ scope: String) -> URL {
        URL.applicationSupportDirectory.appending(path: scope.isEmpty ? "thread-cache" : "thread-cache-" + scope)
    }

    func connectThroughOrbit() {
        lastError = nil
        session?.connectPrimaryAgent()
    }

    /// "Try again" on the Orbit screen: repeats the failed attempt's target.
    func retry() {
        session?.retry()
    }

    func showManualPairing() {
        session?.connectManually()
    }

    func connectWithPairingURL(_ raw: String) {
        lastError = nil
        do {
            let parsed = try PairingURLParser.parse(raw)
            session?.pairManual(serverUrl: parsed.serverURL, pairingCode: parsed.pairingCode)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func openThread(_ threadId: String) {
        if openThreadId != threadId { openThread = nil }
        openThreadId = threadId
        // The session closes the scope's other thread, and subscribes this one now or as soon as
        // a connection attaches.
        session?.openThread(threadId: threadId)
        restoreThread(threadId)
    }

    func closeThread(_ threadId: String) {
        if openThreadId == threadId {
            openThreadId = nil
            openThread = nil
        }
        session?.closeThread(threadId: threadId)
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
            child.connectWithPairingURL(raw)
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
            if let child = linked.removeValue(forKey: id) {
                child.disconnect()
            } else {
                KeychainStore.clearSession(scope: id)
                try? FileManager.default.removeItem(at: Self.cacheDirectory(id))
            }
        }
        linked.removeAll()
        UserDefaults.standard.removeObject(forKey: "linkedSessions")
    }

    private func restoreThread(_ id: String) {
        guard let reader = offlineReader, openThread == nil else { return }
        let connection = state?.connectionId
        Task {
            guard let cached = try? await reader.recent(thread: id),
                  state?.connectionId == connection, openThreadId == id,
                  openThread == nil, !cached.entries.isEmpty else { return }
            openThread = cached
        }
    }

    func reconnect() {
        session?.retry()
    }

    func disconnect() {
        if scope.isEmpty {
            clearLinkedSessions()
            Task { await PushRegistration.shared.unregister() }
        }
        session?.signOut()
        lastError = nil
    }

    func handleScenePhase(_ phase: ScenePhase) {
        guard phase == .active else { return }
        session?.foreground()
        for child in linked.values { child.handleScenePhase(phase) }
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

    /// Opens a thread from a link. Rust decides: this store keeps it only for its already known
    /// environment; any other link opens right away in its environment's own scope.
    func open(_ link: ThreadLink) {
        defer { pendingLink = link }
        if let child = linkedStore(for: link.environmentId) {
            // Tries again if that environment's last attempt failed.
            _ = child.session?.openLink(environmentId: link.environmentId)
            return
        }
        if session?.openLink(environmentId: link.environmentId) == .here { return }
        guard scope.isEmpty else { return }
        let child = CoreStore(scope: link.environmentId)
        linked[link.environmentId] = child
        UserDefaults.standard.set(Array(linked.keys), forKey: "linkedSessions")
        child.session?.connectEnvironment(environmentId: link.environmentId)
    }

    private func linkedStore(for environmentId: String) -> CoreStore? {
        linked[environmentId] ?? linked.values.first { $0.environmentId == environmentId }
    }

    /// Hands the pending link to the workspace once.
    func consumePendingLink() -> ThreadLink? {
        defer { pendingLink = nil }
        return pendingLink
    }

    // MARK: - Session events

    fileprivate func handleState(_ newState: FfiSessionState) {
        if let state, newState.revision <= state.revision { return }
        // The open thread stays: the session resubscribes it on the new connection. Only a switch
        // to another server drops it, with that server's inbox.
        if newState.connectionId != state?.connectionId {
            shell = nil
            offlineReader = nil
        }
        if newState.identityEpoch != state?.identityEpoch ?? 0 {
            openThread = nil
            openThreadId = nil
        }
        state = newState
        switch newState.phase {
        case let .idle(message):
            if let message { lastError = message }
        case let .live(status):
            if status != .connected { shell?.synchronized = false }
            if status == .connected { lastError = nil }
        default:
            break
        }
        if newState.offlineReady, offlineReader == nil, let reader = session?.offlineReader() {
            showOffline(reader, connection: newState.connectionId)
        }
    }

    /// The cache's saved inbox stands in until the server's arrives.
    private func showOffline(_ reader: OfflineReader, connection: UInt64) {
        offlineReader = reader
        Task {
            let saved = await reader.savedShell()
            guard state?.connectionId == connection else { return }
            if shell == nil { shell = saved }
            if let id = openThreadId { restoreThread(id) }
        }
    }

    fileprivate func handleShell(_ snapshot: FfiShellSnapshot, connectionId: UInt64) {
        guard connectionId >= (state?.connectionId ?? 0) else { return }
        if snapshot.synchronized || shell == nil { shell = snapshot }
    }

    fileprivate func handleThread(_ snapshot: FfiThreadSnapshot, connectionId: UInt64) {
        guard connectionId >= (state?.connectionId ?? 0) else { return }
        if openThreadId == snapshot.threadId {
            openThread = snapshot
        }
    }

    /// The thread's stream reported `thread.deleted` on this store's connection. A thread missing
    /// from the shell is not deleted (older settled threads are left out), so only this and a
    /// successful delete clear a draft.
    fileprivate func handleThreadDeleted(_ threadId: String, connectionId: UInt64) {
        guard connectionId >= (state?.connectionId ?? 0) else { return }
        drafts[threadId] = nil
    }

    fileprivate func handleError(_ message: String) {
        lastError = message
    }

    fileprivate func handleProvidersChanged() {
        providersRevision &+= 1
    }
}

/// Stores what Rust hands over in this store's Keychain scope, and hops session events to the
/// main actor.
private final class SessionBridge: SessionListener, @unchecked Sendable {
    private weak var store: CoreStore?
    private let scope: String

    init(store: CoreStore, scope: String) {
        self.store = store
        self.scope = scope
    }

    func onState(state: FfiSessionState) {
        Task { @MainActor [weak store] in store?.handleState(state) }
    }

    func onSave(session: FfiSavedSession?) {
        if let session {
            KeychainStore.saveSession(
                serverURL: session.serverUrl,
                bearerToken: session.bearer,
                orbitServerId: session.orbitServerId,
                environmentId: session.environmentId,
                scope: scope
            )
        } else {
            KeychainStore.clearSession(scope: scope)
        }
    }

    func onShell(connectionId: UInt64, snapshot: FfiShellSnapshot) {
        Task { @MainActor [weak store] in store?.handleShell(snapshot, connectionId: connectionId) }
    }

    func onThread(connectionId: UInt64, snapshot: FfiThreadSnapshot) {
        Task { @MainActor [weak store] in store?.handleThread(snapshot, connectionId: connectionId) }
    }

    func onThreadDeleted(connectionId: UInt64, threadId: String) {
        Task { @MainActor [weak store] in store?.handleThreadDeleted(threadId, connectionId: connectionId) }
    }

    func onError(message: String) {
        Task { @MainActor [weak store] in store?.handleError(message) }
    }


    func onProvidersChanged() {
        Task { @MainActor [weak store] in store?.handleProvidersChanged() }
    }
}
