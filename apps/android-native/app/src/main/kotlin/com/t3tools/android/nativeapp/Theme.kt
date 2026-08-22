package com.t3tools.android.nativeapp

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle

private val T3Colors = darkColorScheme(
  primary = Color(0xFF5B9CFF),
  onPrimary = Color.Black,
  secondary = Color(0xFF34D399),
  background = Color.Black,
  onBackground = Color(0xFFF4F4F5),
  surface = Color(0xFF09090B),
  onSurface = Color(0xFFF4F4F5),
  surfaceVariant = Color(0xFF18181B),
  onSurfaceVariant = Color(0xFFA1A1AA),
  outline = Color(0xFF3F3F46),
  error = Color(0xFFF87171),
)

val LocalT3Appearance = staticCompositionLocalOf { AppSettings().resolveAppearance() }

@Composable
fun T3NativeTheme(settings: AppSettings = AppSettings(), content: @Composable () -> Unit) {
  val appearance = settings.resolveAppearance()
  CompositionLocalProvider(LocalT3Appearance provides appearance) {
    MaterialTheme(
      colorScheme = T3Colors,
      typography = scaledTypography(appearance.baseFontSize / DEFAULT_BASE_FONT_SIZE),
      content = content,
    )
  }
}

private fun scaledTypography(scale: Float): Typography {
  val base = Typography()
  fun TextStyle.scaled() = copy(fontSize = fontSize * scale, lineHeight = lineHeight * scale)
  return Typography(
    displayLarge = base.displayLarge.scaled(),
    displayMedium = base.displayMedium.scaled(),
    displaySmall = base.displaySmall.scaled(),
    headlineLarge = base.headlineLarge.scaled(),
    headlineMedium = base.headlineMedium.scaled(),
    headlineSmall = base.headlineSmall.scaled(),
    titleLarge = base.titleLarge.scaled(),
    titleMedium = base.titleMedium.scaled(),
    titleSmall = base.titleSmall.scaled(),
    bodyLarge = base.bodyLarge.scaled(),
    bodyMedium = base.bodyMedium.scaled(),
    bodySmall = base.bodySmall.scaled(),
    labelLarge = base.labelLarge.scaled(),
    labelMedium = base.labelMedium.scaled(),
    labelSmall = base.labelSmall.scaled(),
  )
}
