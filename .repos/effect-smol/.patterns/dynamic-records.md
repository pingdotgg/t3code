# Dynamic Record Safety

An **open key** comes from external data or is determined at runtime. A key is
**closed** only when selected from an explicit internal list; TypeScript types
do not close external input at runtime.

## Rules

1. **Owned internal dictionary:** use
   `Object.create(null) as Record<string, Value>` (or `Map` without record/JSON
   interop). Direct open-key reads and writes are safe. Use `Object.hasOwn` when
   stored `undefined` must differ from absence.
2. **External record:** use `Object.hasOwn(record, key)` for presence. Never use
   `in`, truthiness, or `record[key] !== undefined`. Enumerate with
   `Object.keys` / `values` / `entries`, never `for...in`.
3. **Normal object or instance:** write open keys with
   `Record.assignProperty(target, key, value)`. It protects only writes;
   presence checks still require `Object.hasOwn`.
4. **Existing public API:** preserve its output prototype. Build with a
   null-prototype dictionary, then return `{ ...internalMap }` when a normal
   object is required.

## `Object.assign`

| Case                                 | Policy                                                |
| ------------------------------------ | ----------------------------------------------------- |
| Null-rooted target + open source     | `Object.assign` allowed                               |
| New normal target + open source      | Use `{ ...source }`                                   |
| New custom-prototype object          | Use `Object.setPrototypeOf({ ...source }, Proto)`     |
| Existing normal target + open source | Copy own enumerable keys with `Record.assignProperty` |
| Normal target + closed source        | `Object.assign` allowed                               |

Therefore `Object.assign({}, openSource)` is forbidden. A source is closed only
when constructed internally with explicit properties, for example
`{ name: options.name }`; passing `options` directly is not closed.
Use `Reflect.ownKeys` plus an enumerable check when symbols must be copied.

## Property Syntax

- Safe: `{ [key]: value }` and `{ ...source }`; both create own data properties.
- Unsafe for data: `{ __proto__: value }`; it changes the literal's prototype.
