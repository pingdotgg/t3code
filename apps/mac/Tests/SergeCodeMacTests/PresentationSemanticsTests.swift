import Testing

@testable import SergeCodeMac

@Suite("Presentation semantics")
struct PresentationSemanticsTests {
    @Test("reconnect presentation escalates after repeated attempts")
    func reconnectEscalation() {
        let settling = ConnectionPhase.reconnecting(attempt: 2)
        #expect(settling.statusText == "Reconnecting…")
        #expect(!settling.needsAttention)

        let delayed = ConnectionPhase.reconnecting(attempt: 3)
        #expect(delayed.statusText == "Still reconnecting · attempt 3")
        #expect(delayed.needsAttention)
        #expect(delayed.symbolName == "arrow.triangle.2.circlepath")
    }

    @Test("settings destinations have unique visible labels")
    func settingsDestinations() {
        let tabs = SettingsTab.allCases
        #expect(tabs.count == 8)
        #expect(Set(tabs.map(\.title)).count == tabs.count)
        #expect(tabs.allSatisfy { !$0.symbolName.isEmpty })
    }
}
