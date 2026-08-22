# plugin runtime

internal effect service for t3 product plugins.

it uses a deterministic, stack-safe reconciliation planner and one effect child scope per active plugin. `PluginRuntime` is provided through `layer()`, so the composing effect scope owns shutdown. updates stage changed plugins and their dependents, publish contributions atomically, and roll back without replacing the live composition when activation fails.

cordis is not a dependency. a pure-only executor was rejected because plugin lifetimes and async cleanup should be owned by effect scopes.
