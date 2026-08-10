# Auldric donor migration gate

This file no longer authorizes a port order. The legacy runtime is not a migration source. Issue #14
must classify donor material before any bounded Marketing rebuild begins.

## Required inventory row

Each product-relevant donor item needs:

| Field         | Required decision                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------- |
| Source        | Exact legacy path and immutable ref                                                            |
| Capability    | User or domain requirement, independent of donor implementation                                |
| Class         | Rebuild Marketing, split, replace with T3, retire, historical evidence, or upstream dependency |
| Current truth | What is actually present and proved in this repository                                         |
| Owner         | Executable issue and responsible boundary                                                      |
| Seam          | Supported T3 extension point or explicit upstream dependency                                   |
| Data          | Migration/backfill, idempotency, conflict, deletion, retention, and rollback                   |
| Risk          | Organization, actor, permission, prompt, and platform-invariance concerns                      |
| Proof         | Targeted tests and before/after evidence                                                       |
| Disposition   | Retain requirement, rebuild, replace, archive, or delete                                       |

No inventory row is approved merely because it appears in the legacy repository or this schema.
Mixed modules require a reviewed split. Shared platform behaviour always resolves to T3.

**Decision:** no legacy code port is authorized by this document.

**Next action:** #14 produces the reviewed inventory.

**Parked until:** a row has an approved Marketing owner, supported seam, migration/rollback, and
testable acceptance criteria.
