---
"effect": patch
---

Refactor CLI built-in options to use Effect services with `GlobalFlag`

Built-in CLI flags (`--help`, `--version`, `--completions`, `--log-level`) are now implemented as Effect services using `Context.Reference`. This provides:

- **Visibility**: Built-in flags now appear in help output's "GLOBAL FLAGS" section
- **Extensibility**: Users can register custom global flags via `GlobalFlag.add`
- **Override capability**: Built-in flag behavior can be replaced or disabled
- **Composability**: Flags compose via Effect's service system

New `GlobalFlag` module exports:

- `Action<A>` and `Setting<A>` types for different flag behaviors
- `Help`, `Version`, `Completions`, `LogLevel` references for built-in flags
- `add`, `remove`, `clear` functions for managing global flags

Example:

```typescript
const app = Command.make("myapp")
Command.run(app, { version: "1.0.0" }).pipe(
  GlobalFlag.add(CustomFlag, customFlagValue)
)
```
