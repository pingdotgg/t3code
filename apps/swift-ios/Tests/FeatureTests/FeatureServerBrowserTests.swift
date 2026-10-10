import Foundation
import Testing
@testable import T3Code

@Suite("Server browser viewer lifecycle")
@MainActor
struct FeatureServerBrowserTests {
    @Test func selectionStaysPinnedAndFallsBackWhenClosed() {
        let model = FeatureServerBrowserModel(threadID: "scoped", client: BrowserManagerStub())
        model.receive(.list(threadID: "wire", value: list([tab("one", time: "2"), tab("two", time: "1")])))
        #expect(model.selectedID == "one")
        model.receive(.event(event("navigated", tab: tab("two", time: "3"), revision: 2)))
        #expect(model.selectedID == "one")
        model.receive(.event(event("closed", tab: tab("one"), revision: 3)))
        #expect(model.selectedID == "two")
        model.receive(.event(event("closed", tab: tab("two"), revision: 4)))
        #expect(model.loaded)
        #expect(model.count == 0)
        #expect(model.selected == nil)
        #expect(model.connection == nil)
    }

    @Test func oldRevealsDoNotReopenButFreshRequestsDo() {
        let model = FeatureServerBrowserModel(threadID: "scoped", client: BrowserManagerStub())
        var one = tab("one"); one.reveal = true; one.revealRequest = .init(id: "old", force: false)
        model.receive(.list(threadID: "wire", value: list([one])))
        #expect(model.revealRequest == nil)
        one.revealRequest = .init(id: "fresh", force: true)
        model.receive(.event(event("navigated", tab: one, revision: 2)))
        #expect(model.revealRequest == .init(id: "fresh", tabID: "one", force: true))
        model.consumeReveal()
        model.receive(.event(event("navigated", tab: one, revision: 3)))
        #expect(model.revealRequest == nil)
        model.receive(.event(event("closed", tab: one, revision: 4)))
        #expect(model.count == 0)
    }

    @Test func lateTicketCannotRestorePreviousTabOrBackgroundStream() async throws {
        let manager = BrowserManagerStub()
        let model = FeatureServerBrowserModel(threadID: "environment:thread", client: manager)
        model.receive(.list(threadID: "wire", value: list([tab("one", time: "2"), tab("two")])))
        manager.holdAccess = true
        let pending = Task { await model.connect() }
        await manager.waitForAccess()
        model.select("two")
        manager.finishAccess()
        await pending.value
        #expect(model.connection == nil)
        let background = Task { await model.connect() }
        await manager.waitForAccess()
        model.suspend()
        manager.finishAccess()
        await background.value
        #expect(model.connection == nil)
        manager.holdAccess = false
        await model.connect()
        let connection = try #require(model.connection)
        #expect(connection.tabID == "two")
        #expect(connection.threadID == "wire")
        #expect(manager.requestedThreadIDs.allSatisfy { $0 == "environment:thread" })
        model.receive(.status(.streaming, nil), connectionID: connection.id)
        model.suspend()
        model.receive(.status(.streaming, nil), connectionID: connection.id)
        #expect(!model.stream.streaming)
        #expect(model.connection == nil)
    }

    @Test func hostSetupDoesNotRetryOnForegroundUntilExplicitReconnect() async throws {
        let manager = BrowserManagerStub()
        let model = FeatureServerBrowserModel(threadID: "scoped", client: manager)
        model.receive(.list(threadID: "wire", value: list([tab("one")])))
        await model.connect()
        let id = try #require(model.connection?.id)
        model.receive(.hostSetup(.init(need: "sandbox", command: "sudo npx t3 browser setup")), connectionID: id)
        model.suspend()
        await model.connect()
        #expect(manager.requestedThreadIDs.count == 1)
        #expect(model.stream.hostSetup != nil)
        model.reload()
        await model.connect()
        #expect(manager.requestedThreadIDs.count == 2)
        #expect(model.stream.hostSetup == nil)
    }

    @Test func refusedTicketsHaveABoundedRetryBudget() async throws {
        let manager = BrowserManagerStub()
        let model = FeatureServerBrowserModel(threadID: "scoped", client: manager)
        model.receive(.list(threadID: "wire", value: list([tab("one")])))
        for _ in 0..<3 {
            await model.connect()
            model.receive(.unauthorized, connectionID: try #require(model.connection?.id))
        }
        #expect(model.attempt == 2)
        #expect(model.stream.error?.contains("refused") == true)
    }

    @Test func independentModelsDoNotMixSameWireThreadAcrossEnvironments() async throws {
        let first = FeatureServerBrowserModel(threadID: "environment-one:wire", client: BrowserManagerStub())
        let second = FeatureServerBrowserModel(threadID: "environment-two:wire", client: BrowserManagerStub())
        first.receive(.list(threadID: "wire", value: list([tab("one")])))
        second.receive(.list(threadID: "wire", value: list([tab("two")])))
        #expect(first.tabs.map(\.id) == ["one"])
        #expect(second.tabs.map(\.id) == ["two"])
    }

    private func tab(_ id: String, time: String = "1") -> ServerBrowserTab {
        .init(threadId: "wire", tabId: id, navStatus: .init(_tag: "Idle"),
              canGoBack: false, canGoForward: false, runtime: "server", updatedAt: time)
    }
    private func list(_ tabs: [ServerBrowserTab]) -> ServerBrowserList {
        .init(sessions: tabs, serverEpoch: "epoch", revision: 1)
    }
    private func event(_ type: String, tab: ServerBrowserTab, revision: Int) -> ServerBrowserEvent {
        .init(type: type, threadId: "wire", tabId: tab.id, createdAt: "now", serverEpoch: "epoch",
              revision: revision, snapshot: type == "closed" ? nil : tab)
    }
}

@MainActor
private final class BrowserManagerStub: FeatureServerBrowserManaging {
    var holdAccess = false
    var requestedThreadIDs: [String] = []
    private var access: CheckedContinuation<Void, Never>?
    private var accessWaiter: CheckedContinuation<Void, Never>?

    func serverBrowserUpdates(threadID: String) async throws -> AsyncThrowingStream<FeatureServerBrowserUpdate, Error> {
        AsyncThrowingStream { $0.finish() }
    }
    func refreshServerBrowsers(threadID: String) async throws -> ServerBrowserList {
        .init(sessions: [], serverEpoch: "epoch", revision: 1)
    }
    func connectServerBrowser(threadID: String, tabID: String) async throws -> FeatureServerBrowserConnection {
        requestedThreadIDs.append(threadID)
        if holdAccess {
            await withCheckedContinuation { continuation in
                access = continuation
                accessWaiter?.resume(); accessWaiter = nil
            }
        }
        return .init(environmentID: "environment", threadID: "wire", tabID: tabID,
                     access: try .ticketed(environmentURL: URL(string: "https://relay.example")!, ticket: "short-lived"),
                     interactive: true)
    }
    func waitForAccess() async {
        guard access == nil else { return }
        await withCheckedContinuation { accessWaiter = $0 }
    }
    func finishAccess() { access?.resume(); access = nil }
}
