package expo.modules.kotlin.views

import android.content.Context
import android.widget.FrameLayout
import expo.modules.kotlin.AppContext

open class ExpoView(context: Context, val appContext: AppContext) : FrameLayout(context)
