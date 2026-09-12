import Testing
@testable import T3Code

@Suite("Connection details")
struct ConnectionDetailsTests {
    @Test
    func parsesRawPairingURL() throws {
        let details = try ConnectionDetailsParser.parse(
            "http://192.168.1.42:3773/pair#token=PAIRCODE"
        )

        #expect(details.endpoint == "http://192.168.1.42:3773")
        #expect(details.pairingCode == "PAIRCODE")
    }

    @Test
    func parsesHostedPairingURL() throws {
        let details = try ConnectionDetailsParser.parse(
            "https://app.t3.codes/pair?host=https%3A%2F%2Fdesktop.tailnet.ts.net%2F#token=PAIRCODE"
        )

        #expect(details.endpoint == "https://desktop.tailnet.ts.net")
        #expect(details.pairingCode == "PAIRCODE")
    }

    @Test(arguments: [
        "t3code://pair?pairingUrl=https%3A%2F%2Fremote.example.com%2Fpair%23token%3Dpairing-token",
        "t3code:?pairingUrl=https%3A%2F%2Fremote.example.com%2Fpair%23token%3Dpairing-token",
        "t3code-swiftui://pair?pairingUrl=https%3A%2F%2Fremote.example.com%2Fpair%23token%3Dpairing-token",
        "t3code-swiftui-dev://pair?pairingUrl=https%3A%2F%2Fremote.example.com%2Fpair%23token%3Dpairing-token",
    ])
    func unwrapsMobileQRCode(_ payload: String) throws {
        let details = try ConnectionDetailsParser.parse(payload)

        #expect(details.endpoint == "https://remote.example.com")
        #expect(details.pairingCode == "pairing-token")
    }

    @Test
    func extractsPairingURLFromSurroundingText() throws {
        let details = try ConnectionDetailsParser.parse(
            "Pairing URL: http://10.0.0.8:18773/pair#token=ABC123\nOpen this on your phone."
        )

        #expect(details.endpoint == "http://10.0.0.8:18773")
        #expect(details.pairingCode == "ABC123")
    }

    @Test(arguments: [
        "token",
        "pairing_token",
        "pairingToken",
        "pairing_code",
        "pairingCode",
        "code",
    ])
    func acceptsEveryPairingCodeQueryAlias(_ alias: String) throws {
        let details = try ConnectionDetailsParser.parse(
            "https://remote.example.com/pair?\(alias)=ABC123"
        )

        #expect(details.endpoint == "https://remote.example.com")
        #expect(details.pairingCode == "ABC123")
    }

    @Test
    func removesPunctuationCopiedWithAProseLink() throws {
        let details = try ConnectionDetailsParser.parse(
            "Connect with (https://remote.example.com/pair?code=ABC123). Then return."
        )

        #expect(details.endpoint == "https://remote.example.com")
        #expect(details.pairingCode == "ABC123")
    }

    @Test
    func keepsBalancedIPv6BracketsWhileTrimmingProse() throws {
        let details = try ConnectionDetailsParser.parse(
            "Use http://[fe80::1]:3773/pair?code=ABC123!"
        )

        #expect(details.endpoint == "http://[fe80::1]:3773")
        #expect(details.pairingCode == "ABC123")
    }

    @Test
    func splitsManualAddressAndCode() throws {
        let details = try ConnectionDetailsParser.parse("192.168.20.2:3773 ABC123")

        #expect(details.endpoint == "http://192.168.20.2:3773")
        #expect(details.pairingCode == "ABC123")
    }

    @Test
    func mapsCancellationToUsefulCopy() {
        let message = ConnectionErrorCopy.message(for: "cancelled")

        #expect(!message.lowercased().contains("cancelled"))
        #expect(message.contains("Make sure T3 Code is running"))
    }
}

@Suite("Local endpoint detection")
struct LocalEndpointDetectionTests {
    @Test(arguments: [
        "localhost",
        "studio.local",
        "127.0.0.1",
        "10.20.30.40",
        "172.20.10.2",
        "192.168.213.171",
        "[::1]",
        "::1",
        "[fe80::aede:48ff:fe00:1122]:3773",
        "fd12:3456:789a::1",
        "fc00::1",
    ])
    func recognizesLocalHosts(_ host: String) {
        #expect(EndpointNetworkScope.isLocalHost(host))
    }

    @Test(arguments: [
        "8.8.8.8",
        "172.32.0.1",
        "example.com",
        "2001:4860:4860::8888",
    ])
    func rejectsPublicHosts(_ host: String) {
        #expect(!EndpointNetworkScope.isLocalHost(host))
    }

    @Test
    func bracketsBareIPv6DuringNormalization() throws {
        let endpoint = try ConnectionDetailsParser.normalizedEndpoint("::1")

        #expect(endpoint == "http://[::1]")
    }
}
