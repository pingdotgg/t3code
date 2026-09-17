---
"effect": patch
---

Schema: make schemas directly extendable as classes with static method support
and remove `Schema.asClass`.

`Bottom` and `BottomLazy` now include the class-compatible `new` signature,
while `BottomWithoutNew` and `BottomLazyWithoutNew` expose the schema protocol
without it for schema types that define a specialized construct signature.

**Example**

```ts
import { Schema } from "effect"

class MyString extends Schema.String {
  static readonly decodeUnknownSync = Schema.decodeUnknownSync(this)
}

MyString.decodeUnknownSync("a") // "a"
```
