import Foundation

struct ServerBrowserNavigation: Decodable, Equatable, Sendable {
    let _tag: String
    var url: String?
    var title: String?
    var code: Int?
    var description: String?
}

struct ServerBrowserReveal: Decodable, Equatable, Sendable {
    let id: String
    let force: Bool
}

struct ServerBrowserTab: Decodable, Equatable, Identifiable, Sendable {
    let threadId: String
    let tabId: String
    var navStatus: ServerBrowserNavigation
    let canGoBack: Bool
    let canGoForward: Bool
    var runtime: String?
    var reveal: Bool?
    var revealRequest: ServerBrowserReveal?
    var updatedAt: String

    var id: String { tabId }
    var url: String { navStatus.url ?? "" }
    var title: String {
        if let title = navStatus.title, !title.isEmpty { return title }
        return URL(string: url)?.host ?? "Browser"
    }
}

struct ServerBrowserList: Decodable, Equatable, Sendable {
    let sessions: [ServerBrowserTab]
    let serverEpoch: String
    let revision: Int
}

struct ServerBrowserEvent: Decodable, Equatable, Sendable {
    let type: String
    let threadId: String
    let tabId: String
    let createdAt: String
    let serverEpoch: String
    let revision: Int
    var snapshot: ServerBrowserTab?
    var url: String?
    var title: String?
    var code: Int?
    var description: String?
}

/// Replays events that arrived after a list was captured. Epoch changes require
/// a fresh list; revisions from different server processes cannot be compared.
struct ServerBrowserTabs: Equatable, Sendable {
    let threadID: String
    private(set) var serverEpoch: String?
    private(set) var revision = 0
    private(set) var loaded = false
    private(set) var sessions: [ServerBrowserTab] = []
    private var listRevision = -1
    private var replay: [ServerBrowserEvent] = []
    private var retiredEpochs: Set<String> = []
    private var pendingEpoch: String?
    private var droppedReplayRevision: [String: Int] = [:]

    init(threadID: String) { self.threadID = threadID }

    var tabs: [ServerBrowserTab] { sessions.filter { $0.runtime == "server" } }

    /// False means this list is stale, including lists from before a restart.
    @discardableResult
    mutating func receive(_ list: ServerBrowserList) -> Bool {
        guard !retiredEpochs.contains(list.serverEpoch),
              pendingEpoch == nil || pendingEpoch == list.serverEpoch,
              serverEpoch != list.serverEpoch || list.revision >= listRevision,
              list.revision >= (droppedReplayRevision[list.serverEpoch] ?? -1) else { return false }
        if let previous = serverEpoch, previous != list.serverEpoch { retiredEpochs.insert(previous) }
        pendingEpoch = nil
        serverEpoch = list.serverEpoch
        listRevision = list.revision
        revision = list.revision
        loaded = true
        sessions = list.sessions.filter { $0.threadId == threadID }
        replay = replay.filter { $0.serverEpoch == list.serverEpoch && $0.revision > list.revision }
        for event in replay.sorted(by: { $0.revision < $1.revision }) { apply(event) }
        return true
    }

    /// Returns true when the owner must fetch a fresh list.
    @discardableResult
    mutating func receive(_ event: ServerBrowserEvent) -> Bool {
        guard event.threadId == threadID, !retiredEpochs.contains(event.serverEpoch) else { return false }
        guard event.serverEpoch != serverEpoch || event.revision > listRevision else { return false }
        replay.append(event)
        if replay.count > 200 {
            let dropped = replay.removeFirst()
            droppedReplayRevision[dropped.serverEpoch] = max(
                droppedReplayRevision[dropped.serverEpoch] ?? -1, dropped.revision
            )
        }
        if let serverEpoch, event.serverEpoch != serverEpoch {
            pendingEpoch = event.serverEpoch
            return true
        }
        if pendingEpoch != nil { return true }
        apply(event)
        return droppedReplayRevision[event.serverEpoch] != nil && !loaded
    }

    private mutating func apply(_ event: ServerBrowserEvent) {
        guard event.revision > revision else { return }
        serverEpoch = event.serverEpoch
        revision = event.revision
        let index = sessions.firstIndex { $0.tabId == event.tabId }
        switch event.type {
        case "closed":
            if let index { sessions.remove(at: index) }
        case "failed":
            if let index {
                sessions[index].navStatus = .init(
                    _tag: "LoadFailed", url: event.url, title: event.title,
                    code: event.code, description: event.description
                )
                sessions[index].updatedAt = event.createdAt
            }
        default:
            guard let tab = event.snapshot, tab.threadId == threadID, tab.tabId == event.tabId else { return }
            if let index { sessions[index] = tab } else { sessions.append(tab) }
        }
    }
}

/// The shape consumed by the existing JS DeviceHubAccess transport. Only a
/// short-lived ticket crosses the bridge, including for managed relay routes.
struct ServerBrowserAccess: Codable, Equatable, Sendable {
    let httpBase: String
    let wsBase: String
    let query: [String: String]
    let credentials: Bool

    static func ticketed(environmentURL: URL, ticket: String) throws -> Self {
        guard !ticket.isEmpty,
              var components = URLComponents(url: environmentURL, resolvingAgainstBaseURL: false),
              let scheme = components.scheme, ["http", "https"].contains(scheme),
              components.host != nil else { throw ServerBrowserError.invalidAddress }
        components.path = "/api/preview-stream"
        components.query = nil
        components.fragment = nil
        components.user = nil
        components.password = nil
        guard let http = components.url else { throw ServerBrowserError.invalidAddress }
        components.scheme = scheme == "https" ? "wss" : "ws"
        guard let ws = components.url else { throw ServerBrowserError.invalidAddress }
        return .init(httpBase: http.absoluteString, wsBase: ws.absoluteString,
                     query: ["wsTicket": ticket], credentials: false)
    }
}

enum ServerBrowserError: LocalizedError {
    case invalidAddress, missingResource
    var errorDescription: String? {
        switch self {
        case .invalidAddress: "The browser stream address is invalid."
        case .missingResource: "The browser viewer is missing from this app build."
        }
    }
}
