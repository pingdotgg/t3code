import Testing

@testable import SergeCodeMac

@Suite("Inspector presentation")
struct InspectorPresentationTests {
    @Test("selection is a precondition, not just a content switch")
    func selectionGatesPresentation() {
        // The welcome hero disables the inspector's toolbar toggle, so a
        // panel presented without a selected thread cannot be dismissed.
        #expect(!InspectorPresentation.isPresented(requested: true, hasSelection: false))
        #expect(InspectorPresentation.isPresented(requested: true, hasSelection: true))
    }

    @Test("a stored request stays off until the user asks for it")
    func requestIsHonouredOnlyWhenMade() {
        #expect(!InspectorPresentation.isPresented(requested: false, hasSelection: true))
        #expect(!InspectorPresentation.isPresented(requested: false, hasSelection: false))
    }
}
