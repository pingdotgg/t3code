package com.t3tools.android.nativeapp

import android.content.Context
import io.noties.markwon.Markwon
import io.noties.markwon.ext.strikethrough.StrikethroughPlugin
import io.noties.markwon.ext.tables.TablePlugin
import io.noties.markwon.ext.tasklist.TaskListPlugin

internal fun createMarkdownRenderer(context: Context): Markwon = Markwon.builder(context)
  .usePlugin(StrikethroughPlugin.create())
  .usePlugin(TablePlugin.create(context))
  .usePlugin(TaskListPlugin.create(context))
  .build()
