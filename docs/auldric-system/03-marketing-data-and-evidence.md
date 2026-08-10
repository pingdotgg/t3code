# Marketing data and evidence

This document preserves the target ownership rules for issues #5, #6, #8, and #9. It does not claim
that a Marketing database or evidence path exists in this repository today.

## Ownership target

- A verified T3 actor remains the authentication authority. Auldric may map that actor only to an
  organization, Marketing workspace, and Marketing role.
- Canonical customer Marketing content belongs to the authenticated organization's physical
  workspace database. Unrelated organizations never share it.
- A central service may own bounded catalog, identity mapping, entitlement, and routing metadata,
  but not canonical customer content.
- An internal documentation workspace is never a customer fallback.
- T3 environment, thread, session, device, runtime, and actor identifiers remain opaque references.
  Thread identity may provide provenance, never artifact or authorization authority.

## Canonical records

The target store covers sources, accepted reusable context, workflow instances, plans, artifact
heads and immutable revisions, decisions, reviews, next actions, and saved outputs. Writes require
an expected version and idempotency key. Stale writes return explicit conflict state. “Saved” means
canonical read-back and survival across reopen/reload.

## Evidence contract

Marketing context keeps these states distinct:

- source capability, access, import, indexing, and freshness;
- retrieved evidence and provenance;
- accepted reusable facts;
- assumptions, conflicts, gaps, questions, and disconfirmation signals;
- plan/stage readiness and unresolved decisions;
- context budget and evidence receipt.

Source content is evidence, not instruction. Retrieval is bounded to the authorized active
workspace. Missing evidence lowers confidence or blocks only dependent claims/actions. It never
causes invented evidence, silent mutation, whole-corpus injection, cross-organization access, or a
fallback into Dev.
