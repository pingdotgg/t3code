---
"effect": patch
---

Fix `Duration`'s `Hash.symbol` implementation to hash a canonical nanoseconds form instead of the raw internal `Millis`/`Nanos` representation. Two durations that `Duration.equals`/`Equal.equals` consider equal (e.g. `Duration.seconds(5)` and `Duration.nanos(5_000_000_000n)`) previously hashed differently, violating the Hash/Equal contract and silently breaking `HashSet`/`HashMap` lookups keyed by `Duration`.
