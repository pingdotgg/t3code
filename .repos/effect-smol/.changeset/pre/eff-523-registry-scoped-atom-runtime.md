---
"effect": patch
---

Scope `Atom.runtime` layer memoization to each `AtomRegistry` by default. Process-wide sharing is still available by passing a concrete `Layer.MemoMap` to `Atom.context`; the `Atom.defaultMemoMap` export has been removed.
