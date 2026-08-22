package com.t3tools.android.nativeapp

internal data class ThreadStreamPolicy(
  val publish: Boolean,
  val persist: Boolean,
)

internal fun threadStreamPolicy(
  kind: String?,
  wasSynchronized: Boolean,
  isSynchronized: Boolean,
  isActive: Boolean,
) = when {
  kind == "snapshot" -> ThreadStreamPolicy(publish = true, persist = false)
  kind == "synchronized" && isSynchronized -> ThreadStreamPolicy(publish = true, persist = true)
  !wasSynchronized -> ThreadStreamPolicy(publish = false, persist = false)
  else -> ThreadStreamPolicy(publish = true, persist = !isActive)
}
