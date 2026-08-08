package com.t3tools.android.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class PairingTargetTest {
  @Test
  fun parses_direct_and_hosted_pairing_urls() {
    val direct = PairingTargetParser.parse("https://host.example:444/pair#token=one-time")
    val hosted = PairingTargetParser.parse(
      "https://app.t3.codes/pair?host=http%3A%2F%2F10.0.0.2%3A13773#token=hosted-token",
    )

    assertEquals("https://host.example:444/", direct.httpBaseUrl)
    assertEquals("wss://host.example:444/", direct.wsBaseUrl)
    assertEquals("one-time", direct.credential)
    assertEquals("http://10.0.0.2:13773/", hosted.httpBaseUrl)
    assertEquals("ws://10.0.0.2:13773/", hosted.wsBaseUrl)
    assertEquals("hosted-token", hosted.credential)
  }

  @Test
  fun rejects_pairing_urls_without_a_token() {
    assertFailsWith<IllegalArgumentException> {
      PairingTargetParser.parse("https://host.example/pair")
    }
  }
}
