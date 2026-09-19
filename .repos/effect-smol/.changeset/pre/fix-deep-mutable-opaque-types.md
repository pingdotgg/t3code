---
"effect": patch
---

Fix `Types.DeepMutable` to preserve built-in objects, Effect data types, and other objects with methods or symbol-keyed properties while recursively making arrays, tuples, maps, sets, and plain records mutable.
