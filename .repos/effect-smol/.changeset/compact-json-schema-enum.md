---
"effect": patch
---

Schema: collapse same-type literal branches in JSON Schema output into a single `enum` array, closes #1868.

Before:

```json
{
  "anyOf": [
    { "type": "string", "enum": ["A"] },
    { "type": "string", "enum": ["B"] }
  ]
}
```

After:

```json
{
  "type": "string",
  "enum": ["A", "B"]
}
```
