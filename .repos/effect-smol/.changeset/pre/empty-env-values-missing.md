---
"effect": patch
---

Treat empty strings as missing values in built-in `ConfigProvider`s by default.

`ConfigProvider.fromEnv`, `ConfigProvider.fromDotEnvContents`, `ConfigProvider.fromDotEnv`, `ConfigProvider.fromUnknown`, and `ConfigProvider.fromDir` now treat literal empty strings as absent values when loaded as values, allowing `Config.withDefault` and `Config.option` to recover. Container discovery still reflects the source structure. Pass `preserveEmptyStrings: true` to restore the previous behavior.

`ConfigProvider.fromDotEnv({ expandVariables: true })` now expands variables consistently with `ConfigProvider.fromDotEnvContents`.
