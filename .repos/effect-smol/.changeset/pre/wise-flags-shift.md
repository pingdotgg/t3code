---
"effect": patch
---

Refactor unstable CLI global flags to command-scoped declarations.

### Breaking changes

- Remove `GlobalFlag.add`, `GlobalFlag.remove`, and `GlobalFlag.clear`
- Add `Command.withGlobalFlags(...)` as the declaration API for command/subcommand scope
- Change `GlobalFlag.setting` constructor to curried form which carries type-level identifier:
  - before: `GlobalFlag.setting({ flag, ... })`
  - after: `GlobalFlag.setting("id")({ flag })`
- Change setting context identity to a stable type-level string:
  - `effect/unstable/cli/GlobalFlag/${id}`

### Behavior changes

- Global flags are now scoped by command path (root-to-leaf declarations)
- Out-of-scope global flags are rejected for the selected subcommand path
- Help now renders only global flags active for the requested command path
- Setting defaults are sourced from `Flag` combinators (`optional`, `withDefault`) rather than setting constructor defaults
