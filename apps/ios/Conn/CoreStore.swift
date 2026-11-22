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

    @ObservationIgnored private var core: ConnCore?
    @ObservationIgnored private var activeGeneration: UInt64 = 0

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
            return try await core.launchThread(projectId: projectId, text: trimmed)
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
            return try await core.launchGeneralThread(text: trimmed)
        } catch {
            lastError = error.localizedDescription
            return nil
        }
    }

    func reconnect() {
        core?.reconnect()
    }

    func disconnect() {
        activeGeneration &+= 1
        core?.disconnect()
        core = nil
        KeychainStore.clearSession()
        status = nil
        shell = nil
        openThread = nil
        openThreadId = nil
        serverURL = nil
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

    fileprivate func handleStatus(_ newStatus: FfiConnectionStatus, generation: UInt64) {
        guard generation == activeGeneration else { return }
        status = newStatus
        if case let .failed(message) = newStatus {
            lastError = message
        } else if newStatus == .connected {
            lastError = nil
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
