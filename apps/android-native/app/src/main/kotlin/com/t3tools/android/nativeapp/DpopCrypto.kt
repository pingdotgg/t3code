package com.t3tools.android.nativeapp

import java.math.BigInteger
import java.security.MessageDigest
import java.util.Base64

/** Pure DPoP helpers shared by Keystore signer and JVM unit tests. */
internal object DpopCrypto {
  fun jwkThumbprint(x: String, y: String): String {
    val input = """{"crv":"P-256","kty":"EC","x":"$x","y":"$y"}"""
    return base64Url(sha256(input.toByteArray()))
  }

  fun accessTokenHash(accessToken: String): String = base64Url(sha256(accessToken.toByteArray()))

  fun normalizeHtu(url: String): String {
    val withoutFragment = url.substringBefore('#')
    val withoutQuery = withoutFragment.substringBefore('?')
    return withoutQuery.trimEnd('/')
  }

  fun base64Url(value: ByteArray): String =
    Base64.getUrlEncoder().withoutPadding().encodeToString(value)

  fun sha256(value: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(value)

  fun bigIntegerToUnsigned(value: BigInteger, size: Int): ByteArray {
    val raw = value.toByteArray().dropWhile { it == 0.toByte() }.toByteArray()
    require(raw.size <= size) { "EC coordinate is too large." }
    return ByteArray(size - raw.size) + raw
  }

  fun derEcdsaToJose(signature: ByteArray): ByteArray {
    require(signature.size >= 8 && signature[0] == 0x30.toByte()) { "Invalid ECDSA signature." }
    var index = 1
    val sequenceLength = signature.readDerLength(index).also { index += it.second }.first
    require(index + sequenceLength == signature.size) { "Invalid ECDSA sequence length." }
    require(signature[index++] == 0x02.toByte()) { "Invalid ECDSA R value." }
    val rLength = signature.readDerLength(index).also { index += it.second }.first
    val r = signature.copyOfRange(index, index + rLength).also { index += rLength }
    require(signature[index++] == 0x02.toByte()) { "Invalid ECDSA S value." }
    val sLength = signature.readDerLength(index).also { index += it.second }.first
    val s = signature.copyOfRange(index, index + sLength)
    return r.toFixedUnsigned(32) + s.toFixedUnsigned(32)
  }

  private fun ByteArray.readDerLength(index: Int): Pair<Int, Int> {
    val first = this[index].toInt() and 0xff
    if (first < 0x80) return first to 1
    val count = first and 0x7f
    require(count in 1..2) { "Unsupported DER length." }
    var value = 0
    repeat(count) { value = (value shl 8) or (this[index + 1 + it].toInt() and 0xff) }
    return value to (count + 1)
  }

  private fun ByteArray.toFixedUnsigned(size: Int): ByteArray {
    val unsigned = dropWhile { it == 0.toByte() }.toByteArray()
    require(unsigned.size <= size) { "ECDSA integer is too large." }
    return ByteArray(size - unsigned.size) + unsigned
  }
}
