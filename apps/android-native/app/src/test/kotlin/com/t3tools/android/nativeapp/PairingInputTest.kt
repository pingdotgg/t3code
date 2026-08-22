package com.t3tools.android.nativeapp

import org.junit.Assert.assertEquals
import org.junit.Test

class PairingInputTest {
  @Test
  fun builds_direct_pairing_url_from_ip_and_code() {
    assertEquals(
      "http://100.64.0.1:8080/pair#token=abc-123",
      buildPairingUrl("100.64.0.1:8080", "abc-123"),
    )
  }

  @Test
  fun preserves_complete_pairing_url() {
    val url = "https://example.test/pair#token=abc"
    assertEquals(url, buildPairingUrl(url, ""))
  }

  @Test
  fun extracts_pairing_url_from_mobile_qr_payload() {
    assertEquals(
      "http://127.0.0.1:8080/pair#token=abc",
      extractPairingUrl(
        "t3code://pair?pairingUrl=http%3A%2F%2F127.0.0.1%3A8080%2Fpair%23token%3Dabc",
      ),
    )
  }
}
