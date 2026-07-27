---
"effect": patch
---

Tool: preserve the tool kind when cloning provider-defined and dynamic tools.

`Tool.addDependency`, `setParameters`, `setSuccess`, `setFailure`, `annotate`, and `annotateMerge` previously rebuilt the tool as a user-defined tool, which flipped `Tool.isProviderDefined` to `false`, corrupted the provider `id` (e.g. `anthropic.memory_20250818`), and crashed `Tool.getStrictMode`. These operations now clone the tool while preserving its prototype, `id`, and kind. Provider-defined tools also now carry an empty annotations context so `Tool.getStrictMode`/`annotate` work on them. Closes #2615.
