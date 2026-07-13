import Testing
@testable import T3Kit

@Test func defaultPortMatchesServer() {
    #expect(T3Kit.defaultPort == 3773)
}

@Test func configBuildsIPv6URLs() {
    let config = T3KitConfig(host: "::1", port: 3773, desktopBootstrapToken: "token")

    #expect(config.httpBaseURL.absoluteString == "http://[::1]:3773")
    #expect(config.wsBaseURL.absoluteString == "ws://[::1]:3773")
}
