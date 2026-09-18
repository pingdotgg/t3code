---
"effect": patch
---

Fix equivalence derivation for schema class APIs by adopting the equivalence of
their declared fields. Class declarations previously fell back to
`Equal.equals`, which also compared runtime properties outside the schema and
could make field-equivalent class instances compare as unequal.
