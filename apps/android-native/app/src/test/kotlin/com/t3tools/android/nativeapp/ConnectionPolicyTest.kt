package com.t3tools.android.nativeapp

import org.junit.Assert.assertEquals
import org.junit.Test

class ConnectionPolicyTest {
  @Test
  fun caps_retry_delay_and_resets_from_first_attempt() {
    assertEquals(3_000, ConnectionPolicy.retryDelay(0))
    assertEquals(4_000, ConnectionPolicy.retryDelay(1))
    assertEquals(16_000, ConnectionPolicy.retryDelay(99))
  }

  @Test
  fun reconnects_only_after_a_meaningful_background_period() {
    assertEquals(ResumeAction.Probe, ConnectionPolicy.resumeAction(9_999))
    assertEquals(ResumeAction.Reconnect, ConnectionPolicy.resumeAction(10_000))
  }
}
