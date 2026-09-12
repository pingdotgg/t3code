---
"effect": patch
---

Harden HttpApi documentation HTML rendering.

Scalar descriptions and CDN versions were interpolated without attribute-safe escaping. Embedded OpenAPI JSON in Scalar and Swagger also handled only the exact `</script>` sequence, not other valid [script end-tag forms](https://html.spec.whatwg.org/multipage/parsing.html#script-data-end-tag-name-state).

Attribute values and CDN versions are now encoded for their contexts, and embedded JSON escapes `<` so it cannot close its script element.
