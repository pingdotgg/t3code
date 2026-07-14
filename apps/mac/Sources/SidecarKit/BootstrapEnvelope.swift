import Darwin
import Foundation

/// Codable mirror of `DesktopBackendBootstrap` from
/// `packages/contracts/src/desktopBootstrap.ts`. Field names, optionality,
/// and JSON shape must match the TS `Schema.Struct` exactly — the Node
/// server decodes this exact schema off the bootstrap file descriptor
/// (see `apps/server/src/bootstrap.ts` + `apps/server/src/cli/config.ts`).
///
/// `Encodable`'s synthesized conformance calls `encodeIfPresent` for each
/// `Optional`-typed stored property, which omits the key entirely when the
/// value is `nil` — matching the TS side's `Schema.optional(...)`, which
/// serializes an `undefined` field as an absent key rather than `null`.
public struct BootstrapEnvelope: Codable, Sendable, Equatable {
    /// Always "desktop" — the only literal the TS schema accepts.
    public var mode: String
    public var port: Int
    public var t3Home: String?
    public var host: String
    public var desktopBootstrapToken: String
    public var tailscaleServeEnabled: Bool
    public var tailscaleServePort: Int
    public var otlpTracesUrl: String?
    public var otlpMetricsUrl: String?

    public init(
        port: Int,
        t3Home: String? = nil,
        host: String,
        desktopBootstrapToken: String,
        tailscaleServeEnabled: Bool = false,
        tailscaleServePort: Int = 443,
        otlpTracesUrl: String? = nil,
        otlpMetricsUrl: String? = nil
    ) {
        self.mode = "desktop"
        self.port = port
        self.t3Home = t3Home
        self.host = host
        self.desktopBootstrapToken = desktopBootstrapToken
        self.tailscaleServeEnabled = tailscaleServeEnabled
        self.tailscaleServePort = tailscaleServePort
        self.otlpTracesUrl = otlpTracesUrl
        self.otlpMetricsUrl = otlpMetricsUrl
    }

    /// Encodes the envelope as a single line of JSON (no trailing newline),
    /// suitable for writing to the server's `--bootstrap-fd` stream. The TS
    /// side writes `${bootstrapJson}\n` to the child's stdin/fd3; callers of
    /// this method are expected to append their own newline the same way
    /// (see `ServerProcess`).
    public func encodeLine() throws -> String {
        let data = try JSONEncoder().encode(self)
        guard let json = String(data: data, encoding: .utf8) else {
            throw BootstrapEnvelopeError.encodingFailed
        }
        return json
    }
}

public enum BootstrapEnvelopeError: Error, Sendable {
    case encodingFailed
}

/// Generates the desktop bootstrap token exchanged for a session/bearer
/// token by the local HTTP auth API (`desktop-managed-local` policy).
/// Mirrors the TS side's `crypto.randomBytes(24)` call, but uses 32+ bytes
/// (256 bits) of CSPRNG output for a wider security margin, base64url
/// encoded (RFC 4648 §5) with padding stripped.
public enum BootstrapTokenGenerator {
    public static func generate(byteCount: Int = 32) -> String {
        precondition(byteCount >= 32, "bootstrap token must use at least 32 bytes of entropy")
        var bytes = [UInt8](repeating: 0, count: byteCount)
        bytes.withUnsafeMutableBytes { buffer in
            arc4random_buf(buffer.baseAddress, buffer.count)
        }
        return Data(bytes).base64URLEncodedString()
    }
}

extension Data {
    /// Standard base64 re-encoded as base64url (RFC 4648 §5), no padding.
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
