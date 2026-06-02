---
"effect": patch
---

Schema: add `asClass` API to turn any schema into a class with static method support.

**Example**

```ts
import { Schema } from "effect"

class MyString extends Schema.asClass(Schema.String) {
  static readonly decodeUnknownSync = Schema.decodeUnknownSync(this)
}

MyString.decodeUnknownSync("a") // "a"
```
