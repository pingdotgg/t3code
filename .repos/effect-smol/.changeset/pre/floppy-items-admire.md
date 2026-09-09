---
"effect": patch
---

Change `Type_<>` implementation, from using `Exclude<F, O | M>` type util to `keyof F as xx`, this implementation keeps IDE provenance link. This enables clicking "Go to definition (F12)" in VSCode on an object made from Schema Struct jumps to the correct Struct field definition.
