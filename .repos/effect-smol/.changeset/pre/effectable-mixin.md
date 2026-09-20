---
"effect": patch
---

Add `Effectable.Mixin` to insert the Effect prototype into an existing class inheritance chain. The returned abstract class requires an `asEffect` method and derives its Effect type from that method through polymorphic `this`.
