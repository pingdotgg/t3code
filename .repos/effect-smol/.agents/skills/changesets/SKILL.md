---
name: changesets
description: Changesets. Use after consumer-visible runtime, public API, entrypoint, lifecycle, or wire-format changes, when deciding whether a change is breaking, or when authoring changesets and consumer release notes.
---

Record what consumers need to know after implementation and focused validation.

## Workflow

1. Inspect the complete diff and identify directly affected published packages.
2. Classify impact across source types, runtime behavior, entrypoints, required
   services, lifecycle, and persisted or wire data.
3. Perform the breaking audit below.
4. Record either a reason no changeset is required or one coherent changeset.
   When required, read [authoring.md](authoring.md).
5. Validate package names, frontmatter, bump policy, and consumer-facing text.

Do not include unrelated worktree changes.

## Requirement

Create a changeset for observable runtime behavior changes, including bug
fixes; exported value or public type changes; entrypoint or export-map changes;
changes to required services, errors, ownership, defaults, or lifecycle; and
persisted, serialization, protocol, or wire-format changes.

Tests-only changes, behavior-preserving internal refactors, documentation or
JSDoc maintenance, and unpublished tooling normally do not need one. When
unclear, inspect exports and consumer-visible declarations rather than inferring
from source location.

## Breaking Audit

A change is breaking when valid existing consumer code, configuration, or data
must change to keep compiling or behaving according to the previous contract.
Audit every surface:

- **Names and locations:** exports, entrypoints, compatibility exports, and
  module paths.
- **Call compatibility:** parameters, accepted inputs, overload resolution,
  generic parameters, and defaults.
- **Result compatibility:** return and error types, output narrowing, members,
  inference, and required services.
- **Runtime contracts:** defaults, failures, interruption, concurrency,
  ordering, resource lifetime, acquisition, cleanup, and mutation.
- **Data compatibility:** persisted schemas, encodings, database layouts,
  protocols, and wire formats.

Additive exports, optional parameters, and behavior-preserving implementations
are normally non-breaking. A fix restoring the documented contract is normally
non-breaking but still needs a changeset when its operational impact is
consumer-visible. Verify representative existing calls when overload ordering,
structural assignability, or inference makes compatibility uncertain. API diff
output is mechanical evidence, not a semantic-version decision.

The task is complete when every affected surface and published package is
accounted for and either the no-changeset decision is explicit or one coherent,
valid changeset describes the consumer impact and migration for every break.
