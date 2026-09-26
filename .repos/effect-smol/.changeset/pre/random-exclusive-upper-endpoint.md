---
"effect": patch
---

Fix `Random.nextBetween` and `Crypto.randomBetween` returning their exclusive upper bound when floating-point arithmetic rounds up.
