package expo.modules.t3nativecontrols

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertNull
import org.junit.Test

class T3SecureChannelCryptoTest {
  @Test
  fun derivesRfc5869TestCase1() {
    val okm = T3SecureChannelCrypto.hkdfSha256(
      hex("0b".repeat(22)),
      hex("000102030405060708090a0b0c"),
      hex("f0f1f2f3f4f5f6f7f8f9"),
      42,
    )
    assertArrayEquals(
      hex("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"),
      okm,
    )
  }

  // McGrew and Viega, "The Galois/Counter Mode of Operation", test case 15 (AES-256, no AAD).
  @Test
  fun sealsAndOpensGcmTestCase15() {
    val key = hex("feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308")
    val nonce = hex("cafebabefacedbaddecaf888")
    val plaintext = hex(
      "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a72" +
        "1c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b391aafd255",
    )
    val sealed = hex(
      "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa" +
        "8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662898015ad" +
        "b094dac5d93471bdec1a502270e3cc6c",
    )
    assertArrayEquals(sealed, T3SecureChannelCrypto.seal(key, nonce, plaintext))
    assertArrayEquals(plaintext, T3SecureChannelCrypto.open(key, nonce, sealed))
    val tampered = sealed.copyOf().also { it[0] = (it[0].toInt() xor 1).toByte() }
    assertNull(T3SecureChannelCrypto.open(key, nonce, tampered))
  }

  // NIST CAVS ECC CDH primitive, P-256 COUNT = 0.
  @Test
  fun agreesOnTheCavsP256Secret() {
    val privateKey = hex("7d7dc5f71eb29ddaf80d6214632eeae03d9058af1fb6d22ed80badb62bc1a534")
    assertArrayEquals(
      hex("46fc62106420ff012e54a434fbdd2d25ccc5852060561e68040dd7778997bd7b"),
      T3SecureChannelCrypto.ecdhP256(privateKey, PEER),
    )
  }

  @Test(expected = IllegalArgumentException::class)
  fun rejectsAPointOffTheCurve() {
    val offCurve = PEER.copyOf().also { it[64] = (it[64].toInt() xor 1).toByte() }
    T3SecureChannelCrypto.ecdhP256(ByteArray(31) + byteArrayOf(1), offCurve)
  }

  private companion object {
    val PEER = hex(
      "04700c48f77f56584c5cc632ca65640db91b6bacce3a4df6b42ce7cc838833d287" +
        "db71e509e3fd9b060ddb20ba5c51dcc5948d46fbf640dfe0441782cab85fa4ac",
    )

    fun hex(value: String) =
      ByteArray(value.length / 2) { value.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
  }
}
