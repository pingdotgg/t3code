---
"effect": patch
---

Fix string seed encoding in Random.withSeed so short, trailing, and astral UTF-8 bytes affect deterministic streams.
