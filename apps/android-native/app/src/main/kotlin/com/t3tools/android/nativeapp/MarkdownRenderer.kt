package com.t3tools.android.nativeapp

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.util.TypedValue
import io.noties.markwon.Markwon
import io.noties.markwon.AbstractMarkwonPlugin
import io.noties.markwon.core.MarkwonTheme
import io.noties.markwon.ext.strikethrough.StrikethroughPlugin
import io.noties.markwon.ext.tables.TablePlugin
import io.noties.markwon.ext.tables.TableTheme
import io.noties.markwon.ext.tasklist.TaskListPlugin
import kotlin.math.roundToInt

internal fun createMarkdownRenderer(context: Context): Markwon {
  val density = context.resources.displayMetrics.density
  fun dp(value: Float) = (value * density).roundToInt()
  fun sp(value: Float) = TypedValue.applyDimension(
    TypedValue.COMPLEX_UNIT_SP,
    value,
    context.resources.displayMetrics,
  ).roundToInt()

  val subtle = Color.argb(26, 255, 255, 255)
  val faint = Color.argb(15, 255, 255, 255)
  val divider = Color.argb(20, 255, 255, 255)
  val body = Color.rgb(229, 229, 229)

  return Markwon.builder(context)
    .usePlugin(object : AbstractMarkwonPlugin() {
      override fun configureTheme(builder: MarkwonTheme.Builder) {
        builder
          .linkColor(Color.rgb(96, 165, 250))
          .isLinkUnderlined(true)
          .blockMargin(dp(12f))
          .blockQuoteWidth(dp(2f))
          .blockQuoteColor(subtle)
          .listItemColor(body)
          .bulletListItemStrokeWidth(dp(1.5f))
          .bulletWidth(dp(4f))
          .codeTextColor(Color.rgb(184, 188, 194))
          .codeBlockTextColor(body)
          .codeBackgroundColor(faint)
          .codeBlockBackgroundColor(faint)
          .codeBlockMargin(dp(12f))
          .codeTypeface(Typeface.MONOSPACE)
          .codeBlockTypeface(Typeface.MONOSPACE)
          .codeTextSize(sp(13f))
          .codeBlockTextSize(sp(13f))
          .headingTypeface(Typeface.create("sans-serif", Typeface.BOLD))
          .headingTextSizeMultipliers(floatArrayOf(1.4f, 1.27f, 1.13f, 1f, 1f, 1f))
          .headingBreakHeight(0)
          .headingBreakColor(Color.TRANSPARENT)
          .thematicBreakColor(divider)
          .thematicBreakHeight(dp(1f))
      }
    })
    .usePlugin(StrikethroughPlugin.create())
    .usePlugin(TablePlugin.create(
      TableTheme.Builder()
        .tableCellPadding(dp(8f))
        .tableBorderColor(divider)
        .tableBorderWidth(dp(1f))
        .tableOddRowBackgroundColor(Color.TRANSPARENT)
        .tableEvenRowBackgroundColor(Color.argb(8, 255, 255, 255))
        .tableHeaderRowBackgroundColor(faint)
        .build(),
    ))
    .usePlugin(TaskListPlugin.create(context))
    .build()
}
