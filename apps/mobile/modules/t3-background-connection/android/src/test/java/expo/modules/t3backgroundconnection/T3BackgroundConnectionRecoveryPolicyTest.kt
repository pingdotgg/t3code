package expo.modules.t3backgroundconnection

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class T3BackgroundConnectionRecoveryPolicyTest {
  @Test
  fun `start failure retries only while battery optimization is ignored`() {
    assertTrue(
      T3BackgroundConnectionRecoveryPolicy.shouldScheduleRestartAfterStartFailure(
        batteryOptimizationIgnored = true,
      ),
    )
    assertFalse(
      T3BackgroundConnectionRecoveryPolicy.shouldScheduleRestartAfterStartFailure(
        batteryOptimizationIgnored = false,
      ),
    )
  }

  @Test
  fun `foreground recovers an enabled service that is stopped or not ready`() {
    assertTrue(
      T3BackgroundConnectionRecoveryPolicy.shouldEnsureStartedOnActivityForeground(
        enabled = true,
        serviceRunning = false,
        runtimeReady = false,
      ),
    )
    assertTrue(
      T3BackgroundConnectionRecoveryPolicy.shouldEnsureStartedOnActivityForeground(
        enabled = true,
        serviceRunning = true,
        runtimeReady = false,
      ),
    )
  }

  @Test
  fun `foreground leaves a healthy or disabled service alone`() {
    assertFalse(
      T3BackgroundConnectionRecoveryPolicy.shouldEnsureStartedOnActivityForeground(
        enabled = true,
        serviceRunning = true,
        runtimeReady = true,
      ),
    )
    assertFalse(
      T3BackgroundConnectionRecoveryPolicy.shouldEnsureStartedOnActivityForeground(
        enabled = false,
        serviceRunning = false,
        runtimeReady = false,
      ),
    )
  }
}
