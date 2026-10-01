---
"effect": patch
---

Fix Schema handling of encoded-side checks for container ASTs.

Checks added after `flip` are now preserved as `encodingChecks` across
`Declaration`, `Arrays`, `Objects`, and `Union`, even when rebuilding the AST
does not change child nodes. `toType` now projects those checks consistently,
and parsing applies encoded-side checks to the local encoded value when an
encoding chain is present without allowing encoded-side `parseOptions`
annotations to affect the current parser side.
