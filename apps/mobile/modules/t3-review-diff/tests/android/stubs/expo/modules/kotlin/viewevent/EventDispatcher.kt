package expo.modules.kotlin.viewevent

import expo.modules.kotlin.views.ExpoView
import kotlin.properties.ReadOnlyProperty
import kotlin.reflect.KProperty

@Suppress("FunctionName")
fun ExpoView.EventDispatcher() = object : ReadOnlyProperty<ExpoView, (Map<String, Any>) -> Unit> {
  override fun getValue(
    thisRef: ExpoView,
    property: KProperty<*>
  ): (Map<String, Any>) -> Unit = { payload ->
    thisRef.appContext.events.add(property.name to payload)
  }
}
