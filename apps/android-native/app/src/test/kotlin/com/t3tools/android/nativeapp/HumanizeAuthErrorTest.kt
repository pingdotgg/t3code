package com.t3tools.android.nativeapp

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HumanizeAuthErrorTest {
  @Test
  fun redirect_mismatch_is_short_and_actionable() {
    val raw =
      "ClerkErrorResponse(errors=[Error(message=Redirect url mismatch, longMessage=The current redirect url passed in the sign in or sign up request does not match an authorized redirect URI for this instance. Review authorized redirect urls for your instance. clerk://com.t3tools.t3code.native.experimental.callback)]"
    val message = humanizeAuthError(raw)
    assertTrue(message.contains("redirect URL is not allowlisted"))
    assertTrue(message.length < 200)
  }

  @Test
  fun other_errors_keep_first_line() {
    assertEquals("Bad password", humanizeAuthError("Bad password\nmore detail"))
  }
}
