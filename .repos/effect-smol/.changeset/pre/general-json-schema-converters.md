---
"effect": patch
---

Make JSON Schema dialect conversions preserve custom keywords, translate conditionals, contains, dependencies, identifiers, and tuples where representable, relocate local references after structural changes, and throw instead of silently changing unsupported constraints.
