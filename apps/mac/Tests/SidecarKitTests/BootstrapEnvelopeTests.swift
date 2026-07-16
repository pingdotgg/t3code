import Foundation
import Testing

@testable import SidecarKit

@Suite("BootstrapEnvelope")
struct BootstrapEnvelopeTests {
    // Mirrors packages/contracts/src/desktopBootstrap.ts `DesktopBackendBootstrap`,
    // as it would be serialized by the TS side's
    // `Schema.encodeEffect(Schema.fromJsonString(DesktopBackendBootstrap))`.
    static let fixtureJSON = """
        {"mode":"desktop","port":3773,"t3Home":"/Users/test/Library/Application Support/SergeCode","host":"127.0.0.1","desktopBootstrapToken":"abc123token","tailscaleServeEnabled":false,"tailscaleServePort":443}
        """

    @Test("decodes the TS fixture field-for-field")
    func decodesFixture() throws {
        let envelope = try JSONDecoder().decode(
            BootstrapEnvelope.self, from: Data(Self.fixtureJSON.utf8))

        #expect(envelope.mode == "desktop")
        #expect(envelope.port == 3773)
        #expect(envelope.t3Home == "/Users/test/Library/Application Support/SergeCode")
        #expect(envelope.host == "127.0.0.1")
        #expect(envelope.desktopBootstrapToken == "abc123token")
        #expect(envelope.tailscaleServeEnabled == false)
        #expect(envelope.tailscaleServePort == 443)
        #expect(envelope.otlpTracesUrl == nil)
        #expect(envelope.otlpMetricsUrl == nil)
    }

    @Test("round trips through encode then decode")
    func roundTrips() throws {
        let original = BootstrapEnvelope(
            port: 4000,
            t3Home: "/tmp/base",
            host: "127.0.0.1",
            desktopBootstrapToken: "token-value",
            tailscaleServeEnabled: true,
            tailscaleServePort: 8443,
            otlpTracesUrl: "http://localhost:4318/traces",
            otlpMetricsUrl: nil
        )

        let line = try original.encodeLine()
        let decoded = try JSONDecoder().decode(BootstrapEnvelope.self, from: Data(line.utf8))
        #expect(decoded == original)
    }

    @Test("omits optional fields when nil, matching TS Schema.optional")
    func omitsNilOptionals() throws {
        let envelope = BootstrapEnvelope(
            port: 3773,
            host: "127.0.0.1",
            desktopBootstrapToken: "tok"
        )

        let line = try envelope.encodeLine()
        let object = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]

        #expect(object?["t3Home"] == nil)
        #expect(object?["otlpTracesUrl"] == nil)
        #expect(object?["otlpMetricsUrl"] == nil)
        #expect(object?["mode"] as? String == "desktop")
        #expect(object?["port"] as? Int == 3773)
    }

    @Test("always encodes the tailscale fields explicitly — the envelope value overrides the server default")
    func encodesTailscaleFieldsExplicitly() throws {
        let envelope = BootstrapEnvelope(
            port: 3773,
            host: "127.0.0.1",
            desktopBootstrapToken: "tok"
        )

        let line = try envelope.encodeLine()
        let object = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]

        // The TS schema requires both fields, and the server treats the
        // envelope value as authoritative over its own serve-by-default —
        // so `false` must be present on the wire, never omitted.
        #expect(object?["tailscaleServeEnabled"] as? Bool == false)
        #expect(object?["tailscaleServePort"] as? Int == 443)
    }

    @Test("generates a 32+ byte, base64url-safe token")
    func generatesSecureToken() {
        let token = BootstrapTokenGenerator.generate()

        #expect(!token.contains("+"))
        #expect(!token.contains("/"))
        #expect(!token.contains("="))
        // 32 raw bytes base64-encoded (no padding) is 43 characters.
        #expect(token.count >= 43)

        let other = BootstrapTokenGenerator.generate()
        #expect(token != other)
    }
}
