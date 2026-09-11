import Testing
@testable import T3Code

@Suite("Pairing token precedence")
struct PairingTokenPrecedenceTests {
    @Test(arguments: [
        ("?token=OLD#token=NEW", "NEW"),
        ("?token=QUERY#token=&token=FRAGMENT", "FRAGMENT"),
        ("?token=QUERY#token=%20&token=FRAGMENT", "FRAGMENT"),
        ("#token=&token=FRAGMENT", "FRAGMENT"),
        ("?token=&token=QUERY#token=", "QUERY"),
        ("?token=QUERY#token=", "QUERY"),
        ("?token=#token=FRAGMENT", "FRAGMENT"),
        ("?token=QUERY", "QUERY"),
        ("#token=FRAGMENT", "FRAGMENT"),
    ])
    func prefersNonemptyFragmentWithQueryFallback(_ suffix: String, _ expected: String) throws {
        let url = "https://studio.example/pair" + suffix
        let fields = try PairingURL.parseFields(url)
        let details = try ConnectionDetailsParser.parse(url)
        #expect(fields.pairingCode == expected)
        #expect(details.pairingCode == expected)
    }
}
