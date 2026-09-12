---
"effect": patch
---

Fix `ConfigProvider.fromDotEnvContents` variable expansion to preserve replacement tokens such as `$&` in referenced values.
