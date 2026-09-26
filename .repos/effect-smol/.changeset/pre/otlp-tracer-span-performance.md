---
"effect": patch
---

Speed up `OtlpTracer` span creation and export. Spans now allocate identifiers, attributes, and events lazily, and `Encoding.randomHex` produces flat strings for 16 and 32 character identifiers so serialization no longer flattens ropes.
