---
"@effect/platform-browser": patch
---

Adds an IndexedDB backed implementation of `KeyValueStore` as `BrowserKeyValueStore.layerIndexedDb`. This backend allows for non-blocking `KeyValueStore` operations, unlike the existing `Storage` api backed implementations.
