package expo.modules.t3subscriptionwidget

import org.junit.Assert.assertEquals
import org.junit.Test

class SubscriptionUsageWidgetTest {
  @Test
  fun formatsRelativeResetTimesLikeSharedUsageLimits() {
    val now = 1_000L
    assertEquals("resets in 12m", SubscriptionUsageWidget.formatResetsIn(now + 12 * 60_000, now))
    assertEquals(
      "resets in 2h 13m",
      SubscriptionUsageWidget.formatResetsIn(now + 133 * 60_000, now)
    )
    assertEquals(
      "resets in 3d 4h",
      SubscriptionUsageWidget.formatResetsIn(now + 76 * 3_600_000, now)
    )
    assertEquals("resets in 0m", SubscriptionUsageWidget.formatResetsIn(now + 59_999, now))
    assertEquals("resets now", SubscriptionUsageWidget.formatResetsIn(now, now))
    assertEquals("resets now", SubscriptionUsageWidget.formatResetsIn(now - 1, now))
    assertEquals("Reset time unavailable", SubscriptionUsageWidget.formatResetsIn(null, now))
  }
}
