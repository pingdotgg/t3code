package expo.modules.kotlin

// Per-view event sink for the isolated JVM harness; no React Native bridge is loaded.
class AppContext {
  val events = mutableListOf<Pair<String, Map<String, Any>>>()
}
