package com.t3tools.android.nativeapp

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppearanceModelTest {
  @Test
  fun preserves_the_existing_terminal_preference_as_the_shared_override() {
    val settings = Json.decodeFromString(AppSettings.serializer(), """{"terminalFontSize":12.5}""")

    assertEquals(12.5f, settings.resolveAppearance().terminalFontSize)
    assertTrue(settings.resolveAppearance().terminalFontSizeCustom)
  }

  @Test
  fun migrates_only_the_old_untouched_terminal_default_to_automatic() {
    val untouched = migrateLegacyAppearanceSettings(
      AppSettings(terminalFontSizeOverride = DEFAULT_TERMINAL_FONT_SIZE),
      hasAppearanceSettings = false,
    )
    val customized = migrateLegacyAppearanceSettings(
      AppSettings(terminalFontSizeOverride = 12f),
      hasAppearanceSettings = false,
    )

    assertFalse(untouched.resolveAppearance().terminalFontSizeCustom)
    assertEquals(12f, customized.resolveAppearance().terminalFontSize)
    assertTrue(customized.resolveAppearance().terminalFontSizeCustom)
  }

  @Test
  fun derives_terminal_and_code_sizes_from_text_until_customized() {
    val automatic = AppSettings(baseFontSize = 22f).resolveAppearance()

    assertEquals(14f, automatic.terminalFontSize)
    assertEquals(17f, automatic.codeFontSize)
    assertFalse(automatic.terminalFontSizeCustom)
    assertFalse(automatic.codeFontSizeCustom)

    val custom = AppSettings(
      baseFontSize = 22f,
      terminalFontSizeOverride = 9.7f,
      codeFontSizeOverride = 9.4f,
    ).resolveAppearance()

    assertEquals(9.5f, custom.terminalFontSize)
    assertEquals(9f, custom.codeFontSize)
    assertTrue(custom.terminalFontSizeCustom)
    assertTrue(custom.codeFontSizeCustom)
  }

  @Test
  fun clamps_preferences_to_the_react_native_ranges() {
    assertEquals(11f, normalizeBaseFontSize(2f))
    assertEquals(22f, normalizeBaseFontSize(30f))
    assertEquals(6f, normalizeTerminalFontSize(2f))
    assertEquals(14f, normalizeTerminalFontSize(30f))
    assertEquals(8f, normalizeCodeFontSize(2f))
    assertEquals(18f, normalizeCodeFontSize(30f))
  }
}
