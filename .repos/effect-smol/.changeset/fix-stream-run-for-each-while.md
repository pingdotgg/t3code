---
"effect": patch
---

Fix Stream.runForEachWhile so it continues across chunk boundaries while the predicate returns true and stops when the predicate returns false.
