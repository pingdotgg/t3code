package com.t3tools.android.nativeapp

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

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

@Composable
fun T3NativeTheme(content: @Composable () -> Unit) {
  MaterialTheme(colorScheme = T3Colors, content = content)
}
