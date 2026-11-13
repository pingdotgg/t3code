import CryptoKit
import Foundation

/// P-256 keys for DPoP proofs, as 32-byte private scalars and 65-byte uncompressed public points.
enum T3DpopKeys {
  /// The private scalar followed by the public point.
  static func generate() -> Data {
    let key = P256.Signing.PrivateKey()
    return key.rawRepresentation + key.publicKey.x963Representation
  }

  static func matches(privateKey: Data, publicKey: Data) throws -> Bool {
    try P256.Signing.PrivateKey(rawRepresentation: privateKey).publicKey.x963Representation == publicKey
  }

  /// ES256 over the JWS signing input, as the raw `r‖s` pair JWS uses.
  static func sign(privateKey: Data, signingInput: Data) throws -> Data {
    try P256.Signing.PrivateKey(rawRepresentation: privateKey).signature(for: signingInput).rawRepresentation
  }
}
