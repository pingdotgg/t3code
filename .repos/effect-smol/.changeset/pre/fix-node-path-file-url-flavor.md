---
"@effect/platform-node-shared": patch
---

NodePath: `layerPosix` and `layerWin32` now convert between paths and `file:` URLs using their own platform flavor instead of the host's.
