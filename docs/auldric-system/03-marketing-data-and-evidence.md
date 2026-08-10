# Marketing data and evidence

This document preserves the ownership rules for issues #5, #6, #8, and #9. Issues #5 and #8 now
provide the isolated identity-routing, physical organization-database, and canonical Marketing
content foundations. The production T3 request-authority/role composition (#6) and evidence path
(#9) remain pending.

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

## Implemented issue #8 boundary

- Organization schema v2 upgrades exact v1 transactionally and adds canonical heads, immutable
  revisions, normalized source/review/decision revision edges, and idempotency receipts.
- Sources, workflow instances, plans, artifact heads/revisions, saved outputs, reviews, decisions,
  and next actions are read and written only through the resolved physical organization database.
- Every write carries an expected version, idempotency key, canonical claim, actor reference,
  schema reference, and relevant definition, workflow, environment, lineage, review, decision, or
  registered-renderer references. Success is the committed database read-back.
- A separate injected content-operation authorizer composes with #5 resolution. It neither expands
  lifecycle permissions nor accepts a wire actor. Issue #6 still owns the production role adapter.
- Schema, definition, and renderer references must be accepted by an injected registry. This store
  does not invent issue #19's catalogs or renderers.
- The same registry derives normalized projection facts from validated payloads. Facts are
  immutable with their revision, queryable only inside the resolved organization workspace, and
  never caller-authored; issue #19 still owns their concrete keys and rollup meaning.
- Registered outputs are revisioned under saved-output identities and may project an exact
  canonical revision; they cannot overwrite artifact heads or chain through another saved output.

This is canonical persistence, conflict, and read-back infrastructure. It is not proof that the #9
evidence compiler, #11 consequential audit, #18 Day 0 kernel, or #19 workflow/artifact catalogs
exist.

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

The implemented store covers sources, workflow instances, plans, artifact heads and immutable
revisions, decisions, reviews, next actions, and saved outputs. Writes require an expected version
and idempotency key. Stale writes, duplicate canonical claims, reused idempotency keys, missing
referenced revisions, and unregistered schema/definition/renderer references return explicit
failures. “Saved” means canonical read-back and survival across reopen/reload. Generic projection
facts make source coverage, workflow readiness, and review signals queryable without treating
opaque payloads as a database API. Accepted reusable evidence facts remain owned by issue #9 rather
than being inferred by this persistence layer.

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
