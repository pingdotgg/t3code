package com.t3tools.android.nativeapp

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AndroidDpopSignerTest {
  @Test
  fun signs_dpop_proof_with_keystore_p256_key() {
    val signer = AndroidDpopSigner()
    val proof = signer.proof("POST", "https://relay.t3.codes/v1/client/dpop-token")
    val parts = proof.split('.')
    assertEquals(3, parts.size)
    assertTrue(signer.thumbprint.isNotBlank())
    assertEquals(43, signer.thumbprint.length)

    val withAth = signer.proof(
      "POST",
      "https://relay.t3.codes/v1/environments/env/connect?x=1",
      accessToken = "relay-access",
    )
    assertEquals(3, withAth.split('.').size)
    assertFalse(withAth == proof)
  }
}
