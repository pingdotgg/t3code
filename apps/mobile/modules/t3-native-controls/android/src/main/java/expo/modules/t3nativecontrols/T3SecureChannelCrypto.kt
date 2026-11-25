package expo.modules.t3nativecontrols

import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** The secure channel's primitives: P-256 ECDH, HKDF-SHA256, and AES-256-GCM without additional data. */
internal object T3SecureChannelCrypto {
  private const val HMAC = "HmacSHA256"
  private const val HASH_BYTES = 32

  /** The 32-byte shared secret of a private scalar and a 65-byte uncompressed point. */
  fun ecdhP256(privateKey: ByteArray, publicKey: ByteArray): ByteArray =
    KeyAgreement.getInstance("ECDH").run {
      init(T3DpopKeys.privateKey(privateKey))
      doPhase(T3DpopKeys.publicKey(publicKey), true)
      generateSecret()
    }

  /** RFC 5869. */
  fun hkdfSha256(secret: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
    require(length in 1..255 * HASH_BYTES) { "HKDF-SHA256 derives 1 to 8160 bytes." }
    val mac = Mac.getInstance(HMAC)
    // An empty salt means HashLen zeros; SecretKeySpec rejects an empty key.
    mac.init(SecretKeySpec(if (salt.isEmpty()) ByteArray(HASH_BYTES) else salt, HMAC))
    mac.init(SecretKeySpec(mac.doFinal(secret), HMAC))
    val out = ByteArray(length)
    var block = ByteArray(0)
    var offset = 0
    var counter = 1
    while (offset < length) {
      mac.update(block)
      mac.update(info)
      mac.update(counter++.toByte())
      block = mac.doFinal()
      val count = minOf(HASH_BYTES, length - offset)
      System.arraycopy(block, 0, out, offset, count)
      offset += count
    }
    return out
  }

  /** The ciphertext followed by the 16-byte tag. */
  fun seal(key: ByteArray, nonce: ByteArray, plaintext: ByteArray): ByteArray =
    aesGcm(Cipher.ENCRYPT_MODE, key, nonce).doFinal(plaintext)

  /** Null when the tag does not match. */
  fun open(key: ByteArray, nonce: ByteArray, sealed: ByteArray): ByteArray? =
    try {
      aesGcm(Cipher.DECRYPT_MODE, key, nonce).doFinal(sealed)
    } catch (_: AEADBadTagException) {
      null
    }

  private fun aesGcm(mode: Int, key: ByteArray, nonce: ByteArray): Cipher {
    require(key.size == 32 && nonce.size == 12) {
      "AES-256-GCM takes a 32-byte key and a 12-byte nonce."
    }
    return Cipher.getInstance("AES/GCM/NoPadding").apply {
      init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
    }
  }
}
