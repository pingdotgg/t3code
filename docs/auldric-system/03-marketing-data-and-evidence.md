# Marketing data and evidence

This document preserves the ownership rules for issues #5, #6, #8, and #9. Issue #5 now provides
the isolated identity-routing and physical organization-database foundation. The T3 request
authority composition (#6), canonical Marketing records (#8), and evidence path (#9) remain
pending.

## Implemented issue #5 boundary

- `packages/auldric-marketing-domain` maps only an identity returned by an injected,
  request-scoped server authorizer. There is no wire-decodable verified-actor DTO or fallback
  authority.
- A new-organization bootstrap and an authorized existing-organization join are separate
  operations. Authentication alone cannot enroll a user into an existing organization.
- Every organization resolves to a self-identifying physical SQLite database. Strict migrations
  reject forward, partial, and unidentified schemas.
- Scoped leases prevent deletion from unlinking an open database. Deletion records a durable
  `deleting` state, drains without polling, revokes memberships, and erases retained T3 reference
  values.
- Failed-provision rollback uses the same exclusive drain and a durable `rolled_back` intent.
  Interrupted rollback is resumable; successful rollback atomically tombstones its organization,
  project, and workspace records, revokes memberships, fails provisioning operations, and erases
  retained T3 reference values. Retained actor mappings are global identity routes, not active
  organization membership.

This is routing and lifecycle infrastructure, not proof that canonical Marketing content or
evidence records exist.

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
