package com.t3tools.android.nativeapp

import java.math.BigInteger
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DpopCryptoTest {
  @Test
  fun computes_rfc7638_thumbprint_for_fixed_jwk() {
    // Golden vector: fixed x/y → deterministic thumbprint.
    val x = "MKBCTNIcKUSDii11ySs3526iDZ8AiTo7Tu6KPAqv7D4"
    val y = "4Etl6SRW2YiLUrN5vfvVHuhp7x8PxltmWWlbbM4IFyM"
    val thumbprint = DpopCrypto.jwkThumbprint(x, y)
    assertEquals(43, thumbprint.length)
    assertFalse(thumbprint.contains("="))
    assertEquals(thumbprint, DpopCrypto.jwkThumbprint(x, y))
  }

  @Test
  fun hashes_access_token_for_ath_claim() {
    val hash = DpopCrypto.accessTokenHash("access-token-value")
    assertEquals(43, hash.length)
    assertEquals(hash, DpopCrypto.accessTokenHash("access-token-value"))
    assertFalse(hash == DpopCrypto.accessTokenHash("other-token"))
  }

  @Test
  fun strips_query_and_fragment_from_htu() {
    assertEquals(
      "https://relay.t3.codes/v1/client/dpop-token",
      DpopCrypto.normalizeHtu("https://relay.t3.codes/v1/client/dpop-token?x=1#frag"),
    )
  }

  @Test
  fun pads_ec_coordinates_to_fixed_width() {
    val bytes = DpopCrypto.bigIntegerToUnsigned(BigInteger.valueOf(1), 4)
    assertArrayEquals(byteArrayOf(0, 0, 0, 1), bytes)
  }

  @Test
  fun converts_der_ecdsa_to_jose_r_s() {
    // SEQUENCE { INTEGER 1, INTEGER 2 } with minimal encodings
    val der = byteArrayOf(
      0x30, 0x06,
      0x02, 0x01, 0x01,
      0x02, 0x01, 0x02,
    )
    val jose = DpopCrypto.derEcdsaToJose(der)
    assertEquals(64, jose.size)
    assertEquals(1, jose[31].toInt())
    assertEquals(2, jose[63].toInt())
    assertTrue(jose.copyOfRange(0, 31).all { it == 0.toByte() })
  }
}
