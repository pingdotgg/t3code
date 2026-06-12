---
"effect": patch
---

Refine unstable CLI parent/subcommand flag composition.

- Add `Command.withSharedFlags` conflict validation against existing subcommands, including the `withSubcommands(...).withSharedFlags(...)` composition order.
- Reorder `Command` type parameters to `Command<Name, Input, ContextInput, E, R>` for clearer parent-context modeling.
- Make `Command.withSubcommands` input typing sound for downstream input-based combinators by reflecting that subcommand paths only carry parent context input.
