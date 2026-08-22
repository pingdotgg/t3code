package com.t3tools.android.nativeapp

import kotlin.math.round
import kotlin.math.roundToInt

const val DEFAULT_BASE_FONT_SIZE = 16f
const val MIN_BASE_FONT_SIZE = 11f
const val MAX_BASE_FONT_SIZE = 22f
const val DEFAULT_TERMINAL_FONT_SIZE = 10.5f
const val MIN_TERMINAL_FONT_SIZE = 6f
const val MAX_TERMINAL_FONT_SIZE = 14f
const val DEFAULT_CODE_FONT_SIZE = 12f
const val MIN_CODE_FONT_SIZE = 8f
const val MAX_CODE_FONT_SIZE = 18f

data class ResolvedAppearance(
  val baseFontSize: Float,
  val terminalFontSize: Float,
  val codeFontSize: Float,
  val codeWordBreak: Boolean,
  val terminalFontSizeCustom: Boolean,
  val codeFontSizeCustom: Boolean,
)

data class MarkdownFontSizes(
  val body: Float,
  val small: Float,
  val h1: Float,
  val h2: Float,
  val h3: Float,
  val bodyLineHeight: Float,
  val code: Float,
  val codeLineHeight: Float,
)

data class CodeSurfaceMetrics(
  val fontSize: Float,
  val lineNumberFontSize: Float,
  val rowHeight: Float,
)

fun normalizeBaseFontSize(value: Float): Float =
  value.roundToInt().toFloat().coerceIn(MIN_BASE_FONT_SIZE, MAX_BASE_FONT_SIZE)

fun normalizeTerminalFontSize(value: Float): Float =
  (round(value * 2f) / 2f).coerceIn(MIN_TERMINAL_FONT_SIZE, MAX_TERMINAL_FONT_SIZE)

fun normalizeCodeFontSize(value: Float): Float =
  value.roundToInt().toFloat().coerceIn(MIN_CODE_FONT_SIZE, MAX_CODE_FONT_SIZE)

fun deriveTerminalFontSize(baseFontSize: Float): Float =
  normalizeTerminalFontSize(DEFAULT_TERMINAL_FONT_SIZE * normalizeBaseFontSize(baseFontSize) / DEFAULT_BASE_FONT_SIZE)

fun deriveCodeFontSize(baseFontSize: Float): Float =
  normalizeCodeFontSize(DEFAULT_CODE_FONT_SIZE * normalizeBaseFontSize(baseFontSize) / DEFAULT_BASE_FONT_SIZE)

fun AppSettings.resolveAppearance(): ResolvedAppearance {
  val base = normalizeBaseFontSize(baseFontSize)
  return ResolvedAppearance(
    baseFontSize = base,
    terminalFontSize = terminalFontSizeOverride?.let(::normalizeTerminalFontSize)
      ?: deriveTerminalFontSize(base),
    codeFontSize = codeFontSizeOverride?.let(::normalizeCodeFontSize)
      ?: deriveCodeFontSize(base),
    codeWordBreak = codeWordBreak,
    terminalFontSizeCustom = terminalFontSizeOverride != null,
    codeFontSizeCustom = codeFontSizeOverride != null,
  )
}

fun resolveMarkdownFontSizes(baseFontSize: Float): MarkdownFontSizes {
  val body = normalizeBaseFontSize(baseFontSize)
  val scale = body / DEFAULT_BASE_FONT_SIZE
  val code = maxOf(10, (13 * scale).roundToInt()).toFloat()
  return MarkdownFontSizes(
    body = body,
    small = maxOf(10, (14 * scale).roundToInt()).toFloat(),
    h1 = maxOf(16, (21 * scale).roundToInt()).toFloat(),
    h2 = maxOf(14, (19 * scale).roundToInt()).toFloat(),
    h3 = maxOf(13, (17 * scale).roundToInt()).toFloat(),
    bodyLineHeight = maxOf(18, (23 * scale).roundToInt()).toFloat(),
    code = code,
    codeLineHeight = code + 6,
  )
}

fun resolveCodeSurfaceMetrics(codeFontSize: Float): CodeSurfaceMetrics {
  val font = normalizeCodeFontSize(codeFontSize)
  val scale = font / DEFAULT_CODE_FONT_SIZE
  return CodeSurfaceMetrics(
    fontSize = font,
    lineNumberFontSize = maxOf(8, (11 * scale).roundToInt()).toFloat(),
    rowHeight = maxOf(14, (22 * scale).roundToInt()).toFloat(),
  )
}
