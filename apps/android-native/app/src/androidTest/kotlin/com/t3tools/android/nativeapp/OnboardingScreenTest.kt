package com.t3tools.android.nativeapp

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class OnboardingScreenTest {
  @get:Rule
  val composeRule = createAndroidComposeRule<MainActivity>()

  @Test
  fun fresh_install_shows_pairing_and_t3_connect_entry() {
    composeRule.onNodeWithText("Host or pairing URL").assertIsDisplayed()
    composeRule.onNode(hasText("Add environment") and hasClickAction()).assertIsDisplayed()
    composeRule.onNodeWithText("Scan QR code").assertIsDisplayed()
    composeRule.onNodeWithText("via T3 Connect").assertIsDisplayed()
  }
}
