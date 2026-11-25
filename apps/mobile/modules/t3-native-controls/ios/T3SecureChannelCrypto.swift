import CryptoKit
import Foundation

/// The secure channel's primitives: P-256 ECDH, HKDF-SHA256, and AES-256-GCM without additional data.
enum T3SecureChannelCrypto {
  /// The 32-byte shared secret of a private scalar and a 65-byte uncompressed point. Throws for a
  /// point that is not on the curve.
  static func ecdhP256(privateKey: Data, publicKey: Data) throws -> Data {
    try P256.KeyAgreement.PrivateKey(rawRepresentation: privateKey)
      .sharedSecretFromKeyAgreement(with: P256.KeyAgreement.PublicKey(x963Representation: publicKey))
      .withUnsafeBytes { Data($0) }
  }

  static func hkdfSha256(secret: Data, salt: Data, info: Data, length: Int) throws -> Data {
    // CryptoKit traps rather than throws on an out-of-range length.
    guard (1...255 * SHA256.byteCount).contains(length) else {
      throw CryptoKitError.incorrectParameterSize
    }
    return HKDF<SHA256>.deriveKey(
      inputKeyMaterial: SymmetricKey(data: secret),
      salt: salt,
      info: info,
      outputByteCount: length
    ).withUnsafeBytes { Data($0) }
  }

  /// The ciphertext followed by the 16-byte tag.
  static func seal(key: Data, nonce: Data, plaintext: Data) throws -> Data {
    let box = try AES.GCM.seal(plaintext, using: aesKey(key), nonce: AES.GCM.Nonce(data: nonce))
    return box.ciphertext + box.tag
  }

  /// Nil when the tag does not match.
  static func open(key: Data, nonce: Data, sealed: Data) throws -> Data? {
    guard sealed.count >= 16 else { return nil }
    let box = try AES.GCM.SealedBox(
      nonce: AES.GCM.Nonce(data: nonce),
      ciphertext: sealed.dropLast(16),
      tag: sealed.suffix(16)
    )
    return try? AES.GCM.open(box, using: aesKey(key))
  }

  private static func aesKey(_ bytes: Data) throws -> SymmetricKey {
    guard bytes.count == 32 else { throw CryptoKitError.incorrectKeySize }
    return SymmetricKey(data: bytes)
  }
}
