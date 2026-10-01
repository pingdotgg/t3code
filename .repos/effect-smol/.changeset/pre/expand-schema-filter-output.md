---
"effect": patch
---

Schema: expand `FilterOutput` and add `FilterIssue` for richer filter failures.

The return type of a `Schema.makeFilter` predicate now supports two additional shapes:

- `{ path, issue }` where `issue` is `string | SchemaIssue.Issue` (previously only `{ path, message: string }` was accepted). The `issue` arm lets you attach a fully-formed `Issue` at a nested path without manually constructing a `Pointer`.
- `ReadonlyArray<Schema.FilterIssue>` to report several failures at once. An empty array is success, a single-element array is equivalent to returning that element, and multi-entry arrays are grouped into an `Issue.Composite`. This removes the need to import `SchemaIssue` and hand-build a `Composite` for multi-field validators.

The single-failure shapes (`undefined`, `true`, `false`, `string`, `SchemaIssue.Issue`) are unchanged.

**Breaking**: the object shape renamed from `{ path, message }` to `{ path, issue }`. Call sites that used the old shape must rename the field; the migration is mechanical.

```ts
// before
Schema.makeFilter((o) => ({ path: ["a"], message: "bad" }))

// after
Schema.makeFilter((o) => ({ path: ["a"], issue: "bad" }))
```

Also renamed `{ path, message }` to `{ path, issue }` in the accepted return type of `SchemaGetter.checkEffect`.
