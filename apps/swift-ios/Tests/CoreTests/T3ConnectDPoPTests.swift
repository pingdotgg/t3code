import CryptoKit
import XCTest
@testable import T3Code

final class T3ConnectDPoPTests: XCTestCase {
    func testCanonicalJWKThumbprintAndSignedProofMatchRFCShape() async throws {
        var scalar = Data(repeating: 0, count: 32)
        scalar[31] = 1
        let signer = try T3ConnectDPoPSigner(privateKeyRawRepresentation: scalar)
        let jwk = try await signer.publicJWK()

        XCTAssertEqual(
            jwk.canonicalThumbprintInput,
            #"{"crv":"P-256","kty":"EC","x":"axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY","y":"T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU"}"#
        )
        XCTAssertEqual(jwk.thumbprint, "xx0BcA-wMohw8atYDJOe6peGModklG2wRHBlXHMvl0M")

        let token = "access-token"
        let proof = try await signer.proof(
            method: "post",
            url: URL(string: "https://relay.example/v1/connect?ignored=yes#fragment")!,
            accessToken: token,
            issuedAt: Date(timeIntervalSince1970: 1_800_000_000),
            identifier: UUID(uuidString: "12345678-1234-1234-1234-1234567890ab")!
        )
        let components = proof.value.split(separator: ".").map(String.init)
        XCTAssertEqual(components.count, 3)

        let header = try jsonObject(components[0])
        XCTAssertEqual(header["typ"] as? String, "dpop+jwt")
        XCTAssertEqual(header["alg"] as? String, "ES256")
        XCTAssertNil((header["jwk"] as? [String: Any])?["d"])

        let payload = try jsonObject(components[1])
        XCTAssertEqual(payload["htm"] as? String, "POST")
        XCTAssertEqual(payload["htu"] as? String, "https://relay.example/v1/connect")
        XCTAssertEqual(payload["iat"] as? Int, 1_800_000_000)
        XCTAssertEqual(
            payload["ath"] as? String,
            T3ConnectDPoPSigner.accessTokenHash(token)
        )

        let x = try decodeBase64URL(jwk.x)
        let y = try decodeBase64URL(jwk.y)
        let publicKey = try P256.Signing.PublicKey(
            x963Representation: Data([0x04]) + x + y
        )
        let signature = try P256.Signing.ECDSASignature(
            rawRepresentation: decodeBase64URL(components[2])
        )
        XCTAssertTrue(
            publicKey.isValidSignature(
                signature,
                for: Data("\(components[0]).\(components[1])".utf8)
            )
        )
    }

    func testHTUNormalizationDropsDefaultPortQueryAndFragment() {
        XCTAssertEqual(
            T3ConnectDPoPSigner.normalizedHTU(
                URL(string: "https://relay.example:443/path?query=one#fragment")!
            )?.absoluteString,
            "https://relay.example/path"
        )
        XCTAssertEqual(
            T3ConnectDPoPSigner.normalizedHTU(
                URL(string: "https://relay.example:8443/path")!
            )?.absoluteString,
            "https://relay.example:8443/path"
        )
    }

    func testCloudConfigurationRequiresAllPublicEndpoints() {
        XCTAssertEqual(
            T3ConnectConfiguration.resolve(infoDictionary: [:]),
            .unavailable(
                reason: "This build is missing Clerk publishable key, relay HTTP URL."
            )
        )

        let resolution = T3ConnectConfiguration.resolve(infoDictionary: [
            "T3ConnectClerkPublishableKey": "pk_test_example",
            "T3ConnectClerkJWTTemplate": "relay-template",
            "T3ConnectRelayHTTPURL": "https://relay.example/",
        ])
        guard case let .available(configuration) = resolution else {
            return XCTFail("Expected available T3 Connect configuration")
        }
        XCTAssertEqual(configuration.clerkJWTTemplate, "relay-template")
        XCTAssertEqual(configuration.relayHTTPURL.absoluteString, "https://relay.example")
    }

    private func jsonObject(_ encoded: String) throws -> [String: Any] {
        let data = try decodeBase64URL(encoded)
        return try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
    }

    private func decodeBase64URL(_ value: String) throws -> Data {
        var base64 = value.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        return try XCTUnwrap(Data(base64Encoded: base64))
    }
}
