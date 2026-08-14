package expo.modules.t3backgroundconnection

internal object T3BackgroundConnectionRestartBackoff {
  private const val INITIAL_DELAY_MS = 1_000L
  private const val MAX_DELAY_MS = 5 * 60_000L

  fun delayMs(consecutiveFailures: Int): Long {
    val exponent = consecutiveFailures.coerceIn(0, 20)
    val exponentialDelay = INITIAL_DELAY_MS * (1L shl exponent)
    return exponentialDelay.coerceAtMost(MAX_DELAY_MS)
  }
}
