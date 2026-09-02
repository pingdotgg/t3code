package expo.modules.t3backgroundconnection

internal object T3BackgroundConnectionRecoveryPolicy {
  fun shouldScheduleRestartAfterStartFailure(
    batteryOptimizationIgnored: Boolean
  ): Boolean = batteryOptimizationIgnored

  fun shouldEnsureStartedOnActivityForeground(
    enabled: Boolean,
    serviceRunning: Boolean,
    runtimeReady: Boolean
  ): Boolean = enabled && (!serviceRunning || !runtimeReady)
}
