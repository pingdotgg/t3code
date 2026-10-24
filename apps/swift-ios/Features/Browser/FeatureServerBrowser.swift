import Foundation
import Observation

enum FeatureServerBrowserUpdate: Sendable {
    case list(threadID: String, value: ServerBrowserList)
    case event(ServerBrowserEvent)
}

@MainActor
protocol FeatureServerBrowserManaging: AnyObject {
    func serverBrowserUpdates(threadID: String) async throws -> AsyncThrowingStream<FeatureServerBrowserUpdate, Error>
    func refreshServerBrowsers(threadID: String) async throws -> ServerBrowserList
    func connectServerBrowser(threadID: String, tabID: String) async throws -> FeatureServerBrowserConnection
}

struct FeatureServerBrowserConnection: Identifiable, Equatable, Sendable {
    let id = UUID()
    let environmentID: String
    let threadID: String
    let tabID: String
    let access: ServerBrowserAccess
    let interactive: Bool
}

struct FeatureServerBrowserReveal: Identifiable, Equatable {
    let id: String
    let tabID: String
    let force: Bool
}

/// One instance can observe count/reveal state in a thread without starting a
/// browser stream. Only the visible viewer calls connect().
@MainActor @Observable
final class FeatureServerBrowserModel {
    let threadID: String
    private(set) var state: ServerBrowserTabs?
    private(set) var selectedID: String?
    private(set) var revealRequest: FeatureServerBrowserReveal?
    private(set) var connection: FeatureServerBrowserConnection?
    private(set) var stream = ServerBrowserStreamState()
    private(set) var error: String?
    private(set) var attempt = 0
    @ObservationIgnored private let client: any FeatureServerBrowserManaging
    @ObservationIgnored private var knownReveals: [String: String]?
    @ObservationIgnored private var watchGeneration = 0
    @ObservationIgnored private var accessGeneration = 0
    @ObservationIgnored private var refusals = 0

    init(threadID: String, client: any FeatureServerBrowserManaging, initialTabID: String? = nil) {
        self.threadID = threadID
        self.client = client
        self.selectedID = initialTabID
    }

    var tabs: [ServerBrowserTab] { state?.tabs ?? [] }
    var count: Int { tabs.count }
    var loaded: Bool { state?.loaded == true }
    var selected: ServerBrowserTab? { tabs.first { $0.id == selectedID } }

    func consumeReveal() { revealRequest = nil }

    func select(_ id: String) {
        guard tabs.contains(where: { $0.id == id }), selectedID != id else { return }
        selectedID = id
        resetStream()
    }

    @discardableResult
    func receive(_ update: FeatureServerBrowserUpdate) -> Bool {
        let needsList: Bool
        switch update {
        case let .list(wireID, list):
            if state == nil { state = ServerBrowserTabs(threadID: wireID) }
            guard state?.threadID == wireID else { return false }
            guard state?.receive(list) == true else { return true }
            needsList = false
        case let .event(event):
            if state == nil { state = ServerBrowserTabs(threadID: event.threadId) }
            needsList = state?.receive(event) == true
        }
        if selected == nil {
            selectedID = tabs.max(by: { $0.updatedAt < $1.updatedAt })?.id
            resetStream()
        }
        if loaded {
            let next = Dictionary(uniqueKeysWithValues: tabs.map { ($0.id, $0.revealRequest?.id ?? "") })
            if let previous = knownReveals,
               let tab = tabs.last(where: { $0.reveal == true && previous[$0.id] != next[$0.id] }) {
                revealRequest = .init(id: tab.revealRequest?.id ?? "\(state?.serverEpoch ?? ""):\(tab.id)",
                                      tabID: tab.id, force: tab.revealRequest?.force ?? false)
            }
            knownReveals = next
            if let request = revealRequest, !tabs.contains(where: { $0.id == request.tabID }) { revealRequest = nil }
        }
        return needsList
    }

    func watch() async {
        watchGeneration += 1
        let generation = watchGeneration
        error = nil
        do {
            let updates = try await client.serverBrowserUpdates(threadID: threadID)
            for try await update in updates {
                guard !Task.isCancelled, generation == watchGeneration else { return }
                if receive(update) {
                    let list = try await client.refreshServerBrowsers(threadID: threadID)
                    guard !Task.isCancelled, generation == watchGeneration, let wireID = state?.threadID else { return }
                    _ = receive(.list(threadID: wireID, value: list))
                }
            }
        } catch {
            guard !Task.isCancelled, generation == watchGeneration else { return }
            self.error = error.localizedDescription
        }
    }

    func connect() async {
        accessGeneration += 1
        let generation = accessGeneration
        connection = nil
        guard stream.hostSetup == nil, let selected else { return }
        stream = .init()
        do {
            let connection = try await client.connectServerBrowser(threadID: threadID, tabID: selected.id)
            guard !Task.isCancelled, accessGeneration == generation, selectedID == selected.id else { return }
            self.connection = connection
        } catch {
            guard !Task.isCancelled, accessGeneration == generation else { return }
            stream.receive(.status(.error, error.localizedDescription))
        }
    }

    func suspend() {
        watchGeneration += 1
        accessGeneration += 1
        connection = nil
        stream.suspend()
    }

    func reload() { resetStream(); attempt += 1 }

    private func resetStream() {
        accessGeneration += 1
        connection = nil
        stream = .init()
        refusals = 0
    }

    func receive(_ message: ServerBrowserStreamMessage, connectionID: UUID) {
        guard connection?.id == connectionID, stream.error == nil, !stream.gone else { return }
        if case .unauthorized = message {
            guard refusals < 2 else {
                stream.receive(.status(.error, "Browser access was refused. Reconnect to try again."))
                return
            }
            refusals += 1
            accessGeneration += 1
            connection = nil
            stream.suspend()
            attempt += 1
            return
        }
        stream.receive(message)
        if stream.streaming { refusals = 0 }
    }
}
