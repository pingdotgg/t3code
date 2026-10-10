import Foundation
import Testing
@testable import T3Code

@Suite("Server browser tab reconciliation")
struct ServerBrowserTests {
    @Test func newerCloseWinsOverAnInFlightList() {
        var state = ServerBrowserTabs(threadID: "thread")
        state.receive(event("closed", "one", revision: 12))
        let accepted1 = state.receive(.init(sessions: [tab("one"), tab("two")], serverEpoch: "a", revision: 10))
        #expect(accepted1)
        #expect(state.tabs.map(\.id) == ["two"])
        #expect(state.revision == 12)
        state.receive(event("opened", "one", revision: 11, snapshot: tab("one")))
        #expect(state.tabs.map(\.id) == ["two"])
    }

    @Test func restartRejectsOldListsAndOldEvents() {
        var state = ServerBrowserTabs(threadID: "thread")
        state.receive(.init(sessions: [tab("old")], serverEpoch: "a", revision: 90))
        let accepted2 = state.receive(event("opened", "new", epoch: "b", revision: 1, snapshot: tab("new")))
        #expect(accepted2)
        let accepted3 = state.receive(.init(sessions: [tab("old")], serverEpoch: "a", revision: 91))
        #expect(!accepted3)
        let accepted4 = state.receive(.init(sessions: [tab("new")], serverEpoch: "b", revision: 1))
        #expect(accepted4)
        state.receive(event("opened", "old", revision: 100, snapshot: tab("old")))
        let accepted5 = state.receive(.init(sessions: [tab("old")], serverEpoch: "a", revision: 100))
        #expect(!accepted5)
        #expect(state.tabs.map(\.id) == ["new"])
        #expect(state.revision == 1)
    }

    @Test func filteringAndFailuresPreserveTabOrder() {
        var state = ServerBrowserTabs(threadID: "thread")
        var desktop = tab("desktop"); desktop.runtime = nil
        let foreign = ServerBrowserTab(threadId: "other", tabId: "foreign", navStatus: .init(_tag: "Idle"),
                                       canGoBack: false, canGoForward: false, runtime: "server", updatedAt: "1")
        state.receive(.init(sessions: [tab("one"), desktop, foreign, tab("two")], serverEpoch: "a", revision: 1))
        state.receive(event("navigated", "one", revision: 2, snapshot: tab("one")))
        var failed = event("failed", "one", revision: 3)
        failed.description = "Connection refused"; failed.url = "http://localhost:3000"; failed.code = -102
        state.receive(failed)
        #expect(state.tabs.map(\.id) == ["one", "two"])
        #expect(state.tabs[0].navStatus._tag == "LoadFailed")
        #expect(state.tabs[0].navStatus.description == "Connection refused")
    }

    @Test func replayOverflowRequiresANewerListRatherThanResurrectingTabs() {
        var state = ServerBrowserTabs(threadID: "thread")
        for revision in 1...202 { state.receive(event("closed", "one", revision: revision)) }
        let accepted6 = state.receive(.init(sessions: [tab("one")], serverEpoch: "a", revision: 0))
        #expect(!accepted6)
        let accepted7 = state.receive(.init(sessions: [], serverEpoch: "a", revision: 202))
        #expect(accepted7)
        #expect(state.tabs.isEmpty)
    }

    @Test func oldSnapshotsDefaultToDesktop() throws {
        let tab = try JSONDecoder().decode(ServerBrowserTab.self, from: Data(#"{"threadId":"thread","tabId":"one","navStatus":{"_tag":"Idle"},"canGoBack":false,"canGoForward":false,"updatedAt":"now"}"#.utf8))
        #expect(tab.runtime == nil)
        #expect(tab.revealRequest == nil)
    }

    private func tab(_ id: String) -> ServerBrowserTab {
        .init(threadId: "thread", tabId: id, navStatus: .init(_tag: "Idle"),
              canGoBack: false, canGoForward: false, runtime: "server", updatedAt: "1")
    }

    private func event(_ type: String, _ id: String, epoch: String = "a", revision: Int,
                       snapshot: ServerBrowserTab? = nil) -> ServerBrowserEvent {
        .init(type: type, threadId: "thread", tabId: id, createdAt: "now", serverEpoch: epoch,
              revision: revision, snapshot: snapshot)
    }
}
