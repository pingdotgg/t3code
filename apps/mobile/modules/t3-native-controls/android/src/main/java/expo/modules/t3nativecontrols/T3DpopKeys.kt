package expo.modules.t3nativecontrols

import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.PublicKey
import java.security.Signature
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPrivateKeySpec
import java.security.spec.ECPublicKeySpec

/** P-256 keys for DPoP proofs, as 32-byte private scalars and 65-byte uncompressed public points. */
internal object T3DpopKeys {
  private const val SCALAR_BYTES = 32
  private const val CURVE = "secp256r1"
  private const val ALGORITHM = "SHA256withECDSA"
  // AlgorithmParameters("EC") needs API 26; a generated key carries the same spec on any level.
  private val curve: ECParameterSpec by lazy { (generateKeyPair().public as ECPublicKey).params }

  private fun generateKeyPair() = KeyPairGenerator.getInstance("EC").run {
    initialize(ECGenParameterSpec(CURVE))
    generateKeyPair()
  }

  /** The private scalar followed by the public point. */
  fun generate(): ByteArray {
    val pair = generateKeyPair()
    val point = (pair.public as ECPublicKey).w
    return scalar((pair.private as ECPrivateKey).s) +
      byteArrayOf(UNCOMPRESSED) +
      scalar(point.affineX) +
      scalar(point.affineY)
  }

  // JCA cannot derive a public point, so prove the pair by signing and verifying.
  fun matches(privateKey: ByteArray, publicKey: ByteArray): Boolean {
    val probe = "t3code dpop key check".toByteArray()
    val signature = Signature.getInstance(ALGORITHM).run {
      initSign(privateKey(privateKey))
      update(probe)
      sign()
    }
    return Signature.getInstance(ALGORITHM).run {
      initVerify(publicKey(publicKey))
      update(probe)
      verify(signature)
    }
  }

  /** ES256 over the JWS signing input, as the raw `r‖s` pair JWS uses. */
  fun sign(privateKey: ByteArray, signingInput: ByteArray): ByteArray {
    val der = Signature.getInstance(ALGORITHM).run {
      initSign(privateKey(privateKey))
      update(signingInput)
      sign()
    }
    return rawSignature(der)
  }

  /** Converts JCA's DER `SEQUENCE { INTEGER r, INTEGER s }` to fixed-width `r‖s`. */
  internal fun rawSignature(der: ByteArray): ByteArray {
    var offset = 0
    fun expect(tag: Int) = require(der[offset++].toInt() == tag) { "Malformed ECDSA signature." }
    fun length(): Int {
      val first = der[offset++].toInt() and 0xff
      if (first < 0x80) return first
      var length = 0
      repeat(first and 0x7f) { length = (length shl 8) or (der[offset++].toInt() and 0xff) }
      return length
    }
    fun integer(): BigInteger {
      expect(0x02)
      val length = length()
      return BigInteger(1, der.copyOfRange(offset, offset + length)).also { offset += length }
    }
    expect(0x30)
    length()
    return scalar(integer()) + scalar(integer())
  }

  private fun privateKey(bytes: ByteArray): PrivateKey {
    require(bytes.size == SCALAR_BYTES) { "A DPoP private key is 32 bytes." }
    return KeyFactory.getInstance("EC")
      .generatePrivate(ECPrivateKeySpec(BigInteger(1, bytes), curve))
  }

  private fun publicKey(bytes: ByteArray): PublicKey {
    require(bytes.size == 1 + 2 * SCALAR_BYTES && bytes[0] == UNCOMPRESSED) {
      "A DPoP public key is an uncompressed P-256 point."
    }
    val x = BigInteger(1, bytes.copyOfRange(1, 1 + SCALAR_BYTES))
    val y = BigInteger(1, bytes.copyOfRange(1 + SCALAR_BYTES, bytes.size))
    return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(x, y), curve))
  }

  /** Big-endian and left-padded to 32 bytes, without BigInteger's sign byte. */
  private fun scalar(value: BigInteger): ByteArray {
    val bytes = value.toByteArray()
    return when {
      bytes.size > SCALAR_BYTES -> bytes.copyOfRange(bytes.size - SCALAR_BYTES, bytes.size)
      else -> ByteArray(SCALAR_BYTES - bytes.size) + bytes
    }
  }

  private const val UNCOMPRESSED: Byte = 0x04
}
