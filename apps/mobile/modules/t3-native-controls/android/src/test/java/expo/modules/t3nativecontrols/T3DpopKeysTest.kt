package expo.modules.t3nativecontrols

import java.math.BigInteger
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.security.AlgorithmParameters
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class T3DpopKeysTest {
  @Test
  fun signsRawSignaturesThatVerifyAgainstTheGeneratedPublicKey() {
    val key = T3DpopKeys.generate()
    val privateKey = key.copyOfRange(0, 32)
    val publicKey = key.copyOfRange(32, 97)
    assertTrue(T3DpopKeys.matches(privateKey, publicKey))
    assertFalse(T3DpopKeys.matches(T3DpopKeys.generate().copyOfRange(0, 32), publicKey))

    val input = "header.payload".toByteArray()
    repeat(32) {
      val raw = T3DpopKeys.sign(privateKey, input)
      assertEquals(64, raw.size)
      val verifier = Signature.getInstance("SHA256withECDSA").apply {
        initVerify(jcaPublicKey(publicKey))
        update(input)
      }
      assertTrue(verifier.verify(der(raw)))
    }
  }

  @Test
  fun convertsShortAndSignPaddedDerIntegersToFixedWidth() {
    // r has a 0x00 sign byte (33 bytes); s is a single byte.
    val r = byteArrayOf(0) + ByteArray(32) { 0x80.toByte() }
    val der = byteArrayOf(0x30, (2 + r.size + 3).toByte(), 0x02, r.size.toByte()) + r +
      byteArrayOf(0x02, 0x01, 0x05)
    val expected = ByteArray(32) { 0x80.toByte() } + ByteArray(31) + byteArrayOf(5)
    assertArrayEquals(expected, T3DpopKeys.rawSignature(der))
  }

  private fun jcaPublicKey(bytes: ByteArray) = KeyFactory.getInstance("EC").generatePublic(
    ECPublicKeySpec(
      ECPoint(BigInteger(1, bytes.copyOfRange(1, 33)), BigInteger(1, bytes.copyOfRange(33, 65))),
      AlgorithmParameters.getInstance("EC").run {
        init(ECGenParameterSpec("secp256r1"))
        getParameterSpec(ECParameterSpec::class.java)
      },
    ),
  )

  private fun der(raw: ByteArray): ByteArray {
    fun integer(bytes: ByteArray): ByteArray {
      val value = BigInteger(1, bytes).toByteArray()
      return byteArrayOf(0x02, value.size.toByte()) + value
    }
    val body = integer(raw.copyOfRange(0, 32)) + integer(raw.copyOfRange(32, 64))
    return byteArrayOf(0x30, body.size.toByte()) + body
  }
}
