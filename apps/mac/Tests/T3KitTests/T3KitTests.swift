import Testing
@testable import T3Kit

@Test func defaultPortMatchesServer() {
    #expect(T3Kit.defaultPort == 3773)
}
