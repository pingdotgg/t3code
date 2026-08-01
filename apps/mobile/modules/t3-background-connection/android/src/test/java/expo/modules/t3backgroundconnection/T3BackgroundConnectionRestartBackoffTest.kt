package expo.modules.t3backgroundconnection

import org.junit.Assert.assertEquals
import org.junit.Test

class T3BackgroundConnectionRestartBackoffTest {
  @Test
  fun `repeated failures back off and remain bounded`() {
    assertEquals(1_000L, T3BackgroundConnectionRestartBackoff.delayMs(0))
    assertEquals(2_000L, T3BackgroundConnectionRestartBackoff.delayMs(1))
    assertEquals(4_000L, T3BackgroundConnectionRestartBackoff.delayMs(2))
    assertEquals(256_000L, T3BackgroundConnectionRestartBackoff.delayMs(8))
    assertEquals(300_000L, T3BackgroundConnectionRestartBackoff.delayMs(9))
    assertEquals(300_000L, T3BackgroundConnectionRestartBackoff.delayMs(Int.MAX_VALUE))
  }
}
