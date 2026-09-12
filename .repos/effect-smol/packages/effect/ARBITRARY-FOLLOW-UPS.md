# Native Arbitrary Follow-ups

This file tracks unfinished work for the native Schema-first Arbitrary implementation. Settled behavior and technical
decisions belong in [ARBITRARY.md](ARBITRARY.md); migration guidance belongs in
[ARBITRARY-MIGRATION.md](ARBITRARY-MIGRATION.md). Remove an item from this file when it is resolved rather than keeping
completed implementation history here.

Every production change must preserve the existing guarantees:

- Schema remains the only catalog of primitive and structural generator constructors;
- discarded roots are bounded by `maxDiscards`;
- inspected shrink candidates, including rejected nodes, are bounded by `maxShrinks`;
- shrinking and replay remain deterministic for supported pure callbacks;
- recursive and mutually recursive Schemas retain their productivity guarantees;
- `Sample`, the shrink carrier, the PRNG, generation budgets, and compiler metadata remain private;
- runtime performance and bundle cost are measured before and after the change.

## Conditional research

These items are intentionally dormant until their trigger is observed.

### Finite-domain metadata

Evaluate private finite-domain metadata only if constructive unique generation demonstrates a real exhaustion or
productivity problem. Do not add public cardinality vocabulary preemptively.

### Decoded collection and Declaration profiling

Profile collection generation Links and Declaration decoding only when a new runtime baseline identifies a regression.
ReadonlyMap and ReadonlySet are compiler-owned; Effect-specific HashMap, HashSet, and Chunk keep declaration-local
generation Links.

### Schema-scoped distribution customization

Revisit application-owned distribution overrides, including deterministic Faker integration, only after a concrete
use case establishes the required scope and bundle boundary. A future design must work for checked and nested Schemas,
must not overload filter or declaration annotations with a second contract, and must not require synthetic Schemas in
test integrations. Prefer a derivation-time override mechanism over executable metadata captured by production Schema
modules.

### Trace-informed shrinking

Compare the current `Sample` tree with private structural spans or trace-informed shrinking only when a reproducible
case shows poor shrunk output or excessive candidate traversal.

### Concrete failing-input persistence

Evaluate persistence and reuse of concrete failing inputs last. After `map` or `flatMap`, an Arbitrary may no longer
have a Schema or codec capable of serializing its output, while the existing opaque replay token remains persistable.

## Verification policy

For every activated item, use the narrowest representative validation and record exact commands and artifacts:

- focused Arbitrary runtime tests and typetests when the public types change;
- package type checking and linting;
- seeded generation, shrinking, and replay characterization relevant to the slice;
- focused warm and cold runtime scenarios;
- focused Arbitrary bundle fixtures plus production Schema bundle sentinels.

Do not update public JSDoc, [ARBITRARY.md](ARBITRARY.md), the migration guide, or the changeset until the corresponding
behavior has passed its semantic, runtime, and bundle gates.
