---
"effect": patch
---

Treat only unpadded decimal integers from `0` through `4294967294` as array indices in environment-backed configuration and bracket-path decoding. This preserves numeric-looking object keys and prevents out-of-range environment keys from producing impossible array lengths. Bracket paths that intend to address arrays must use `[1]` instead of `[01]`.
